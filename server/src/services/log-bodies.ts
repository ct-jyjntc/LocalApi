import fs from "fs";
import os from "os";
import path from "path";
import zlib from "node:zlib";
import { promisify } from "node:util";

export const LOG_PREVIEW_CHARS = 8_000;
export const LOG_BODY_MAX_BYTES = 2 * 1024 * 1024;

/** Compression level for today's loose body files (hot path — keep it fast). */
const LOOSE_ZSTD_LEVEL = 6;
/** Archive frames group this much raw text (or this many files) per frame. */
const ARCHIVE_BLOCK_BYTES = 16 * 1024 * 1024;
const ARCHIVE_BLOCK_FILES = 128;
const ARCHIVE_ZSTD_LEVEL = 19;
/** 32MB back-reference window: conversation turns repeat huge prefixes. */
const ARCHIVE_WINDOW_LOG = 25;
const ARCHIVE_MAGIC = "LOCALZST";
const ARCHIVE_VERSION = 1;

type BodyField = "input" | "output" | "reasoning";
const BODY_FIELDS: BodyField[] = ["input", "output", "reasoning"];

type ArchiveIndex = {
  v: number;
  frames: { o: number; l: number }[];
  files: Record<string, { f: number; o: number; l: number }>;
};

const zstdSyncAvailable =
  typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function" &&
  typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function";
const zstdCompressAsync = typeof (zlib as { zstdCompress?: unknown }).zstdCompress === "function"
  ? promisify(zlib.zstdCompress)
  : null;

function zstdParams(level: number, windowLog?: number) {
  const params: Record<number, number> = {
    [zlib.constants.ZSTD_c_compressionLevel]: level,
  };
  if (windowLog) params[zlib.constants.ZSTD_c_windowLog] = windowLog;
  return { params };
}

function compressSync(raw: Buffer, level: number): Buffer | null {
  if (!zstdSyncAvailable) return null;
  try {
    return zlib.zstdCompressSync(raw, zstdParams(level));
  } catch {
    return null;
  }
}

function decompressSync(buf: Buffer): Buffer | null {
  if (!zstdSyncAvailable) return null;
  try {
    return zlib.zstdDecompressSync(buf);
  } catch {
    return null;
  }
}

function dataDir() {
  return path.resolve(process.env.LOCALAPI_DATA_DIR || path.join(process.cwd(), "data"));
}

function dayKey(value?: string | Date) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function logBodiesRoot() {
  return path.join(dataDir(), "log-bodies");
}

function dayDir(day: string) {
  return path.join(logBodiesRoot(), day);
}

function fieldPath(id: string, field: BodyField, day: string) {
  return path.join(dayDir(day), `${id}.${field}.txt`);
}

function archivePath(day: string) {
  return path.join(logBodiesRoot(), `${day}.zsta`);
}

export class DiskTextWriter {
  readonly tmpPath: string;
  preview = "";
  bytes = 0;
  truncated = false;
  private fd: number | null = null;
  private closed = false;
  /** Set when staging to disk failed (e.g. full tmpfs) — logging is skipped, never the request. */
  private failed = false;

  constructor(kind: string) {
    this.tmpPath = path.join(
      os.tmpdir(),
      `localapi-log-${kind}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    try {
      this.fd = fs.openSync(this.tmpPath, "w");
    } catch {
      this.failed = true;
      this.fd = null;
    }
  }

  push(text: string | null | undefined) {
    if (!text || this.closed || this.failed || this.fd == null) return;
    if (this.preview.length < LOG_PREVIEW_CHARS) {
      this.preview += text.slice(0, LOG_PREVIEW_CHARS - this.preview.length);
    }
    if (this.truncated) return;
    const buf = Buffer.from(text);
    if (this.bytes >= LOG_BODY_MAX_BYTES) {
      this.truncated = true;
      return;
    }
    const remain = LOG_BODY_MAX_BYTES - this.bytes;
    const chunk = buf.length > remain ? buf.subarray(0, remain) : buf;
    try {
      fs.writeSync(this.fd, chunk);
    } catch {
      // Disk/temp failures must never break the proxied request — drop the body.
      this.abort();
      return;
    }
    this.bytes += chunk.length;
    if (buf.length > remain) this.truncated = true;
  }

  private abort() {
    this.failed = true;
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    this.closed = true;
    try {
      fs.unlinkSync(this.tmpPath);
    } catch {
      // ignore
    }
  }

  /** Returns the staged file path, or null when staging failed. */
  close() {
    if (this.failed) return null;
    if (this.closed) return this.tmpPath;
    this.closed = true;
    if (this.fd != null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    return this.tmpPath;
  }

  discard() {
    this.close();
    try {
      fs.unlinkSync(this.tmpPath);
    } catch {
      // ignore
    }
  }
}

function moveOrCopy(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    try {
      fs.unlinkSync(from);
    } catch {
      // ignore
    }
  }
}

export function persistLogBodies(
  id: string,
  files: { input?: string | null; output?: string | null; reasoning?: string | null },
  createdAt?: string,
) {
  const day = dayKey(createdAt);
  for (const field of BODY_FIELDS) {
    const src = files[field];
    if (!src) continue;
    try {
      if (!fs.existsSync(src) || fs.statSync(src).size <= 0) {
        try {
          fs.unlinkSync(src);
        } catch {
          // ignore
        }
        continue;
      }
      // Compress on persist; fall back to the raw move when zstd is missing
      // so old Node builds keep working.
      const raw = fs.readFileSync(src);
      const compressed = compressSync(raw, LOOSE_ZSTD_LEVEL);
      if (compressed) {
        const dest = `${fieldPath(id, field, day)}.zst`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, compressed);
        try {
          fs.unlinkSync(src);
        } catch {
          // ignore
        }
      } else {
        moveOrCopy(src, fieldPath(id, field, day));
      }
    } catch {
      // ignore missing temp files
    }
  }
}

export function persistLogBodiesFromText(
  id: string,
  texts: { input?: string | null; output?: string | null; reasoning?: string | null },
  createdAt?: string,
) {
  const files: { input?: string; output?: string; reasoning?: string } = {};
  for (const field of BODY_FIELDS) {
    const text = texts[field];
    if (!text) continue;
    const writer = new DiskTextWriter(field);
    writer.push(text);
    const file = writer.close();
    if (file) files[field] = file;
  }
  persistLogBodies(id, files, createdAt);
}

/** Delete staged temp body files (used for failed requests, whose bodies are not persisted). */
export function discardLogBodies(files: { input?: string | null; output?: string | null; reasoning?: string | null }) {
  for (const field of BODY_FIELDS) {
    const file = files[field];
    if (!file) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

/** Remove orphaned localapi-log-* staging files in the temp dir (leaked by crashed/erroring requests). */
export function sweepStaleLogTempFiles(maxAgeMs = 60 * 60 * 1000) {
  let dir: string;
  let entries: fs.Dirent[];
  try {
    dir = os.tmpdir();
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("localapi-log-")) continue;
    const file = path.join(dir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

/** Read one loose body file, transparently handling raw and .zst variants. */
function readLooseFile(file: string): Buffer | null {
  try {
    const buf = fs.readFileSync(file);
    if (!buf.length) return null;
    if (file.endsWith(".zst")) return decompressSync(buf);
    return buf;
  } catch {
    return null;
  }
}

function readField(id: string, field: BodyField, day: string) {
  const raw = fieldPath(id, field, day);
  for (const file of [raw, `${raw}.zst`]) {
    const buf = readLooseFile(file);
    if (buf) return buf.toString("utf8");
  }
  return null;
}

// --- Day archive (.zsta): seekable frames + a JSON index in the tail. ---
// Layout: [frame][frame]...[index JSON][uint32 LE index length][magic].
// Each frame holds up to ARCHIVE_BLOCK_BYTES of concatenated bodies compressed
// with a long window, so repeated conversation history across requests is
// stored once. Single-body reads only decompress the one frame containing it.

const archiveIndexCache = new Map<string, { mtimeMs: number; index: ArchiveIndex }>();
const frameCache = new Map<string, Buffer>();
const FRAME_CACHE_LIMIT = 4;

function readArchiveIndex(file: string): ArchiveIndex | null {
  try {
    const stat = fs.statSync(file);
    const cached = archiveIndexCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.index;
    if (stat.size < 12) return null;
    const fd = fs.openSync(file, "r");
    try {
      const footer = Buffer.alloc(12);
      fs.readSync(fd, footer, 0, 12, stat.size - 12);
      if (footer.toString("latin1", 4, 12) !== ARCHIVE_MAGIC) return null;
      const indexLen = footer.readUInt32LE(0);
      const indexStart = stat.size - 12 - indexLen;
      if (indexStart < 0) return null;
      const raw = Buffer.alloc(indexLen);
      fs.readSync(fd, raw, 0, indexLen, indexStart);
      const index = JSON.parse(raw.toString("utf8")) as ArchiveIndex;
      if (index.v !== ARCHIVE_VERSION) return null;
      archiveIndexCache.set(file, { mtimeMs: stat.mtimeMs, index });
      return index;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readArchiveFrame(file: string, frameIdx: number, frame: { o: number; l: number }): Buffer | null {
  const cacheKey = `${file}#${frameIdx}`;
  const cached = frameCache.get(cacheKey);
  if (cached) return cached;
  try {
    const fd = fs.openSync(file, "r");
    let compressed: Buffer;
    try {
      compressed = Buffer.alloc(frame.l);
      fs.readSync(fd, compressed, 0, frame.l, frame.o);
    } finally {
      fs.closeSync(fd);
    }
    const raw = decompressSync(compressed);
    if (!raw) return null;
    if (frameCache.size >= FRAME_CACHE_LIMIT) {
      const oldest = frameCache.keys().next().value;
      if (oldest) frameCache.delete(oldest);
    }
    frameCache.set(cacheKey, raw);
    return raw;
  } catch {
    return null;
  }
}

function readArchiveField(id: string, field: BodyField, day: string): string | null {
  const file = archivePath(day);
  if (!fs.existsSync(file)) return null;
  const index = readArchiveIndex(file);
  if (!index) return null;
  const entry = index.files[`${id}.${field}`];
  if (!entry) return null;
  const frame = index.frames[entry.f];
  if (!frame) return null;
  const raw = readArchiveFrame(file, entry.f, frame);
  if (!raw) return null;
  return raw.subarray(entry.o, entry.o + entry.l).toString("utf8");
}

export function readLogBodies(id: string, createdAt?: string) {
  const days = new Set<string>([dayKey(createdAt), dayKey(new Date()), dayKey(new Date(Date.now() - 86400_000))]);
  let input_text: string | null = null;
  let output_text: string | null = null;
  let reasoning_text: string | null = null;
  for (const day of days) {
    input_text ??= readField(id, "input", day) ?? readArchiveField(id, "input", day);
    output_text ??= readField(id, "output", day) ?? readArchiveField(id, "output", day);
    reasoning_text ??= readField(id, "reasoning", day) ?? readArchiveField(id, "reasoning", day);
  }
  if (!input_text && !output_text && !reasoning_text) return null;
  return { input_text, output_text, reasoning_text };
}

export function deleteLogBodies(id: string, createdAt?: string) {
  const days = new Set<string>([dayKey(createdAt), dayKey(new Date()), dayKey(new Date(Date.now() - 86400_000))]);
  for (const day of days) {
    for (const field of BODY_FIELDS) {
      const raw = fieldPath(id, field, day);
      for (const file of [raw, `${raw}.zst`]) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore
        }
      }
    }
  }
  // Note: bodies already folded into a day archive are immutable; they are
  // reclaimed when pruneLogBodies() drops the whole day archive.
}

export function clearAllLogBodies() {
  const root = logBodiesRoot();
  archiveIndexCache.clear();
  frameCache.clear();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function pruneLogBodies(keepDays = 14) {
  const root = logBodiesRoot();
  let removed = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - keepDays * 86400_000;
  for (const entry of entries) {
    const day = entry.name.replace(/\.zsta$/, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!entry.isDirectory() && !entry.name.endsWith(".zsta")) continue;
    const stamp = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isNaN(stamp) || stamp >= cutoff) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      archiveIndexCache.delete(path.join(root, entry.name));
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

/** Pack one completed day directory into a single `<day>.zsta` archive. */
export async function archiveDay(day: string) {
  const dir = dayDir(day);
  const target = archivePath(day);
  const tmp = `${target}.tmp`;
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /\.(input|output|reasoning)\.txt(\.zst)?$/.test(n));
  } catch {
    return null;
  }
  if (!names.length) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return null;
  }
  // Time order keeps turns of one conversation adjacent, which is what the
  // long-window compression feeds on.
  const ordered = names
    .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => a.m - b.m);

  if (!zstdCompressAsync) return null;
  const fd = fs.openSync(tmp, "w");
  const frames: ArchiveIndex["frames"] = [];
  const files: ArchiveIndex["files"] = {};
  let offset = 0;
  let block: Buffer[] = [];
  let blockKeys: { key: string; len: number }[] = [];
  let blockBytes = 0;

  const flushBlock = async () => {
    if (!block.length) return;
    const raw = Buffer.concat(block);
    const compressed = (await zstdCompressAsync(
      raw,
      zstdParams(ARCHIVE_ZSTD_LEVEL, ARCHIVE_WINDOW_LOG),
    )) as Buffer;
    fs.writeSync(fd, compressed);
    const frameIdx = frames.length;
    frames.push({ o: offset, l: compressed.length });
    offset += compressed.length;
    let inner = 0;
    for (const entry of blockKeys) {
      files[entry.key] = { f: frameIdx, o: inner, l: entry.len };
      inner += entry.len;
    }
    block = [];
    blockKeys = [];
    blockBytes = 0;
  };

  try {
    for (const { n } of ordered) {
      const raw = readLooseFile(path.join(dir, n));
      if (!raw || !raw.length) continue;
      const key = n.replace(/\.txt(\.zst)?$/, "");
      block.push(raw);
      blockKeys.push({ key, len: raw.length });
      blockBytes += raw.length;
      if (blockBytes >= ARCHIVE_BLOCK_BYTES || block.length >= ARCHIVE_BLOCK_FILES) {
        await flushBlock();
      }
    }
    await flushBlock();
    const indexJson = Buffer.from(JSON.stringify({ v: ARCHIVE_VERSION, frames, files }));
    fs.writeSync(fd, indexJson);
    const footer = Buffer.alloc(12);
    footer.writeUInt32LE(indexJson.length, 0);
    footer.write(ARCHIVE_MAGIC, 4, "latin1");
    fs.writeSync(fd, footer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }

  // Archive verified on next read via magic + index; drop the loose copies.
  fs.rmSync(dir, { recursive: true, force: true });
  return { day, files: Object.keys(files).length, frames: frames.length, bytes: offset };
}

let archiving = false;

/**
 * Archive one completed day per call. Only days older than yesterday are
 * eligible: a request that started before UTC midnight can still land its
 * body in the previous day's directory moments after it ends.
 */
export async function archiveCompletedDays(now = new Date()) {
  if (archiving) return null;
  const yesterday = dayKey(new Date(now.getTime() - 86400_000));
  let days: string[] = [];
  try {
    days = fs
      .readdirSync(logBodiesRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
  const day = days.find((d) => d < yesterday && !fs.existsSync(archivePath(d)));
  if (!day) return null;
  archiving = true;
  try {
    return await archiveDay(day);
  } catch (error) {
    console.warn(`[log-bodies] failed to archive ${day}:`, error);
    return null;
  } finally {
    archiving = false;
  }
}

let archiverStarted = false;

/** Hourly background consolidation of completed day directories. */
export function startLogBodyArchiver() {
  if (archiverStarted) return;
  archiverStarted = true;
  const timer = setInterval(() => {
    archiveCompletedDays().catch(() => undefined);
  }, 3_600_000);
  timer.unref?.();
  const boot = setTimeout(() => {
    archiveCompletedDays().catch(() => undefined);
  }, 120_000);
  boot.unref?.();
}

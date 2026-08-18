import fs from "fs";
import os from "os";
import path from "path";

export const LOG_PREVIEW_CHARS = 8_000;
export const LOG_BODY_MAX_BYTES = 2 * 1024 * 1024;

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

function fieldPath(id: string, field: "input" | "output" | "reasoning", day: string) {
  return path.join(dayDir(day), `${id}.${field}.txt`);
}

export class DiskTextWriter {
  readonly tmpPath: string;
  preview = "";
  bytes = 0;
  truncated = false;
  private fd: number | null = null;
  private closed = false;

  constructor(kind: string) {
    this.tmpPath = path.join(
      os.tmpdir(),
      `localapi-log-${kind}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    this.fd = fs.openSync(this.tmpPath, "w");
  }

  push(text: string | null | undefined) {
    if (!text || this.closed || this.fd == null) return;
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
    fs.writeSync(this.fd, chunk);
    this.bytes += chunk.length;
    if (buf.length > remain) this.truncated = true;
  }

  close() {
    if (this.closed) return this.tmpPath;
    this.closed = true;
    if (this.fd != null) {
      fs.closeSync(this.fd);
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
  for (const field of ["input", "output", "reasoning"] as const) {
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
      moveOrCopy(src, fieldPath(id, field, day));
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
  for (const field of ["input", "output", "reasoning"] as const) {
    const text = texts[field];
    if (!text) continue;
    const writer = new DiskTextWriter(field);
    writer.push(text);
    files[field] = writer.close();
  }
  persistLogBodies(id, files, createdAt);
}

function readField(id: string, field: "input" | "output" | "reasoning", day: string) {
  const file = fieldPath(id, field, day);
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readLogBodies(id: string, createdAt?: string) {
  const days = new Set<string>([dayKey(createdAt), dayKey(new Date()), dayKey(new Date(Date.now() - 86400_000))]);
  let input_text: string | null = null;
  let output_text: string | null = null;
  let reasoning_text: string | null = null;
  for (const day of days) {
    input_text ??= readField(id, "input", day);
    output_text ??= readField(id, "output", day);
    reasoning_text ??= readField(id, "reasoning", day);
  }
  if (!input_text && !output_text && !reasoning_text) return null;
  return { input_text, output_text, reasoning_text };
}

export function deleteLogBodies(id: string, createdAt?: string) {
  const days = new Set<string>([dayKey(createdAt), dayKey(new Date()), dayKey(new Date(Date.now() - 86400_000))]);
  for (const day of days) {
    for (const field of ["input", "output", "reasoning"] as const) {
      try {
        fs.unlinkSync(fieldPath(id, field, day));
      } catch {
        // ignore
      }
    }
  }
}

export function clearAllLogBodies() {
  const root = logBodiesRoot();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function pruneLogBodies(keepDays = 14) {
  const root = logBodiesRoot();
  let removed = 0;
  let days: string[] = [];
  try {
    days = fs.readdirSync(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - keepDays * 86400_000;
  for (const day of days) {
    const dir = dayDir(day);
    const stamp = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isNaN(stamp) && stamp < cutoff) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // ignore
      }
    }
  }
  return removed;
}

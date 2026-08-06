import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

// Zip-bomb guardrails. A module zip is a code package — these limits are far
// beyond anything legitimate while capping the damage a crafted archive can
// do (upload is already capped at 20 MB compressed).
const MAX_ZIP_ENTRIES = 2_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_SINGLE_ENTRY_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_ENTRY_DEPTH = 16;

function assertSafeZipEntry(entryName: string) {
  const normalized = entryName.replace(/\\/g, "/");
  if (!normalized || normalized.endsWith("/")) return null;
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Zip entry has absolute path: ${entryName}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw new Error(`Zip entry has unsafe path: ${entryName}`);
  }
  if (parts.length > MAX_ENTRY_DEPTH) {
    throw new Error(`Zip entry path is too deep: ${entryName}`);
  }
  return normalized;
}

/** Extract a module zip into targetDir. Rejects path traversal, absolute entries and zip bombs. */
export function extractModuleZip(zipBuffer: Buffer, targetDir: string) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error("Zip archive is empty");
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`Zip archive has too many entries (${entries.length} > ${MAX_ZIP_ENTRIES})`);
  }

  // Pre-flight: the central directory declares uncompressed sizes; reject the
  // archive BEFORE decompressing anything. A lying header is caught again
  // after getData() by the per-entry size re-check below.
  let totalUncompressed = 0;
  for (const entry of entries) {
    const declared = entry.header.size;
    totalUncompressed += declared;
    if (declared > MAX_SINGLE_ENTRY_BYTES) {
      throw new Error(`Zip entry too large: ${entry.entryName}`);
    }
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("Zip archive uncompressed size exceeds limit");
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const resolvedTarget = path.resolve(targetDir);

  for (const entry of entries) {
    const safeName = assertSafeZipEntry(entry.entryName);
    if (!safeName) continue;
    const dest = path.resolve(resolvedTarget, safeName);
    if (dest !== resolvedTarget && !dest.startsWith(resolvedTarget + path.sep)) {
      throw new Error(`Zip entry escapes target directory: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = entry.getData();
    if (data.length > MAX_SINGLE_ENTRY_BYTES) {
      throw new Error(`Zip entry exceeds size limit after decompression: ${entry.entryName}`);
    }
    fs.writeFileSync(dest, data);
  }
}

export function zipDirectoryToBuffer(sourceDir: string): Buffer {
  const zip = new AdmZip();
  const resolved = path.resolve(sourceDir);
  const walk = (dir: string, prefix = "") => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else zip.addLocalFile(full, prefix || undefined, name);
    }
  };
  walk(resolved);
  return zip.toBuffer();
}

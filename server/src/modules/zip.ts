import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

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
  return normalized;
}

/** Extract a module zip into targetDir. Rejects path traversal and absolute entries. */
export function extractModuleZip(zipBuffer: Buffer, targetDir: string) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error("Zip archive is empty");

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
    fs.writeFileSync(dest, entry.getData());
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

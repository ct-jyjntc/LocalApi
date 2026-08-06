import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { extractModuleZip } from "../src/modules/zip";

test("zip extraction: rejects bombs, oversized entries, deep paths; normal zips still work", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-zip-bomb-"));

  const makeZip = (entries: Array<{ name: string; data: Buffer | string; dir?: boolean }>) => {
    const zip = new AdmZip();
    for (const entry of entries) {
      if (entry.dir) zip.addFile(entry.name, Buffer.alloc(0));
      else zip.addFile(entry.name, Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data));
    }
    return zip.toBuffer();
  };

  const throwsWith = (fn: () => void, pattern: RegExp) => {
    try {
      fn();
    } catch (error) {
      assert.match(String(error instanceof Error ? error.message : error), pattern);
      return;
    }
    assert.fail("expected the zip to be rejected");
  };

  try {
    // Baseline: a normal module zip extracts fine.
    const normal = makeZip([
      { name: "src/index.ts", data: "export const ok = 1;\n" },
      { name: "package.json", data: JSON.stringify({ name: "m", version: "1.0.0" }) },
    ]);
    const normalDir = path.join(work, "normal");
    extractModuleZip(normal, normalDir);
    assert.ok(fs.existsSync(path.join(normalDir, "src/index.ts")));

    // High-compression bomb: zeros deflate to a few KB, but the declared
    // uncompressed size must trip the pre-flight checks before any write.
    const singleBomb = makeZip([{ name: "zeros.bin", data: Buffer.alloc(60 * 1024 * 1024) }]);
    assert.ok(singleBomb.length < 1_000_000, "test zip must actually compress well");
    throwsWith(() => extractModuleZip(singleBomb, path.join(work, "bomb")), /entry too large/i);

    // Total-size bomb: several moderate entries whose sum exceeds the cap.
    const totalBomb = makeZip([
      { name: "a.bin", data: Buffer.alloc(40 * 1024 * 1024) },
      { name: "b.bin", data: Buffer.alloc(40 * 1024 * 1024) },
      { name: "c.bin", data: Buffer.alloc(40 * 1024 * 1024) },
    ]);
    throwsWith(
      () => extractModuleZip(totalBomb, path.join(work, "total-bomb")),
      /uncompressed size exceeds limit/i,
    );

    // Too many entries (beyond MAX_ZIP_ENTRIES).
    const many: Array<{ name: string; data: string }> = [];
    for (let i = 0; i < 2_001; i++) many.push({ name: `f${i}.txt`, data: "x" });
    throwsWith(() => extractModuleZip(makeZip(many), path.join(work, "many")), /too many entries/i);

    // Single entry beyond the per-entry cap.
    const singleBig = makeZip([{ name: "big.bin", data: Buffer.alloc(51 * 1024 * 1024) }]);
    throwsWith(() => extractModuleZip(singleBig, path.join(work, "single")), /entry too large/i);

    // Path depth beyond MAX_ENTRY_DEPTH.
    const deepParts = Array.from({ length: 18 }, () => "d");
    const deep = makeZip([{ name: `${deepParts.join("/")}/x.ts`, data: "x" }]);
    throwsWith(() => extractModuleZip(deep, path.join(work, "deep")), /too deep/i);

    // Zip-slip regression: traversal entries are still rejected. adm-zip's
    // addFile() sanitizes "../", so craft the malicious name by mutating the
    // entry object before serializing.
    const slipZip = new AdmZip();
    slipZip.addFile("evil.ts", Buffer.from("x"));
    for (const entry of slipZip.getEntries()) entry.entryName = "../evil.ts";
    throwsWith(() => extractModuleZip(slipZip.toBuffer(), path.join(work, "slip")), /unsafe path/i);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

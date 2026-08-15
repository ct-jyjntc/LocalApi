import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("saveBrandIcon stores bytes and clearBrandIcon removes them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-brand-icon-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "brand-icon-test-secret";

  const { initDb } = await import("../src/db");
  const { clearBrandIcon, getBrandIconUrl, readBrandIcon, saveBrandIcon } = await import("../src/services/branding");

  try {
    initDb();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const url = saveBrandIcon(png);
    assert.match(url, /^\/branding\/icon\?v=/);
    const stored = readBrandIcon();
    assert.ok(stored);
    assert.equal(stored.mime, "image/png");
    assert.deepEqual(stored.buffer, png);
    assert.ok(getBrandIconUrl());

    clearBrandIcon();
    assert.equal(readBrandIcon(), null);
    assert.equal(getBrandIconUrl(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

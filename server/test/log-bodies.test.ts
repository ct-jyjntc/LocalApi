import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Dynamic imports only: dataDir() resolves LOCALAPI_DATA_DIR at call time,
// but keeping imports lazy matches the suite's convention.

test("log bodies: write/read roundtrip through per-file zstd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-logbodies-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  const { persistLogBodiesFromText, readLogBodies, deleteLogBodies, logBodiesRoot } = await import(
    "../src/services/log-bodies"
  );

  const input = "user: 用一句话解释什么是递归".repeat(50);
  const output = "递归就是函数自己调用自己。".repeat(50);
  persistLogBodiesFromText("log-1", { input, output }, "2026-08-19T10:00:00.000Z");

  const dayDir = path.join(logBodiesRoot(), "2026-08-19");
  const names = fs.readdirSync(dayDir);
  // zstd is available on Node >=22.15 — files must land compressed.
  assert.ok(names.includes("log-1.input.txt.zst"), names.join(","));
  assert.ok(names.includes("log-1.output.txt.zst"), names.join(","));
  const rawLen = Buffer.byteLength(input);
  const zstLen = fs.statSync(path.join(dayDir, "log-1.input.txt.zst")).size;
  assert.ok(zstLen < rawLen / 2, `expected compression, raw=${rawLen} zst=${zstLen}`);

  const bodies = readLogBodies("log-1", "2026-08-19T10:00:00.000Z");
  assert.equal(bodies?.input_text, input);
  assert.equal(bodies?.output_text, output);
  assert.equal(bodies?.reasoning_text, null);

  deleteLogBodies("log-1", "2026-08-19T10:00:00.000Z");
  assert.equal(readLogBodies("log-1", "2026-08-19T10:00:00.000Z"), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("log bodies: day archive keeps random access and drops loose files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-logbodies-arch-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  const {
    persistLogBodiesFromText,
    readLogBodies,
    archiveCompletedDays,
    logBodiesRoot,
  } = await import("../src/services/log-bodies");

  const day = "2001-01-01";
  const stamp = `${day}T10:00:00.000Z`;
  // Simulate two turns of one conversation: the second input repeats the
  // first almost in full, which is the redundancy the archive exploits.
  const history = "conversation history ".repeat(2000);
  persistLogBodiesFromText("a", { input: history, output: "answer-a" }, stamp);
  persistLogBodiesFromText("b", { input: `${history} more`, output: "answer-b" }, stamp);

  const result = await archiveCompletedDays(new Date("2001-01-03T00:00:00.000Z"));
  assert.ok(result, "expected an archive to be built");
  assert.equal(result.day, day);
  const archive = path.join(logBodiesRoot(), `${day}.zsta`);
  assert.ok(fs.existsSync(archive));
  assert.ok(!fs.existsSync(path.join(logBodiesRoot(), day)), "loose dir should be gone");

  // The archive should be far smaller than the raw payload.
  const rawTotal = Buffer.byteLength(history) * 2 + 100;
  assert.ok(fs.statSync(archive).size < rawTotal / 4, "archive should compress cross-file redundancy");

  // Random access still works, byte-identical.
  const a = readLogBodies("a", stamp);
  assert.equal(a?.input_text, history);
  assert.equal(a?.output_text, "answer-a");
  const b = readLogBodies("b", stamp);
  assert.equal(b?.input_text, `${history} more`);
  assert.equal(readLogBodies("missing", stamp), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("log bodies: prune removes both day dirs and day archives", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-logbodies-prune-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  const { persistLogBodiesFromText, pruneLogBodies, logBodiesRoot } = await import(
    "../src/services/log-bodies"
  );

  persistLogBodiesFromText("old", { input: "x" }, "2001-01-01T10:00:00.000Z");
  fs.writeFileSync(path.join(logBodiesRoot(), "2001-01-02.zsta"), "fake-archive");
  persistLogBodiesFromText("new", { input: "y" });

  const removed = pruneLogBodies(14);
  assert.equal(removed, 2);
  const left = fs.readdirSync(logBodiesRoot());
  assert.ok(!left.includes("2001-01-01"));
  assert.ok(!left.includes("2001-01-02.zsta"));
  assert.ok(left.some((n) => n !== "2001-01-01"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("log bodies: today and yesterday are never archived", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-logbodies-recent-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  const { persistLogBodiesFromText, archiveCompletedDays, logBodiesRoot } = await import(
    "../src/services/log-bodies"
  );

  const now = new Date("2001-01-10T00:30:00.000Z");
  persistLogBodiesFromText("t", { input: "today" }, "2001-01-10T00:10:00.000Z");
  persistLogBodiesFromText("y", { input: "yesterday" }, "2001-01-09T23:59:00.000Z");

  const result = await archiveCompletedDays(now);
  assert.equal(result, null);
  const names = fs.readdirSync(logBodiesRoot());
  assert.ok(names.includes("2001-01-10"));
  assert.ok(names.includes("2001-01-09"));

  fs.rmSync(dir, { recursive: true, force: true });
});

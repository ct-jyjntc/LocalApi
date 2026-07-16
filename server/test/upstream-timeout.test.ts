import assert from "node:assert/strict";
import test from "node:test";
import { createUpstreamTimeout } from "../src/services/upstream-timeout";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("streaming response releases the total timeout after its first body chunk", async () => {
  const controller = new AbortController();
  const timeout = createUpstreamTimeout(controller, 25);

  timeout.onBodyChunk(true);
  await wait(50);

  assert.equal(controller.signal.aborted, false);
  assert.equal(timeout.didTimeout(), false);
});

test("non-streaming response keeps the full-response timeout", async () => {
  const controller = new AbortController();
  const timeout = createUpstreamTimeout(controller, 25);

  timeout.onBodyChunk(false);
  await wait(50);

  assert.equal(controller.signal.aborted, true);
  assert.equal(timeout.didTimeout(), true);
});

test("manual abort is distinguishable from an upstream timeout", () => {
  const controller = new AbortController();
  const timeout = createUpstreamTimeout(controller, 1000);

  timeout.abort();

  assert.equal(controller.signal.aborted, true);
  assert.equal(timeout.didTimeout(), false);
});

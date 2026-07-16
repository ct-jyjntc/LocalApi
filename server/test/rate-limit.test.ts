import assert from "node:assert/strict";
import test from "node:test";
import { clearRateLimits, consumeRateLimit } from "../src/services/rate-limit";

test("rate limiter rejects requests beyond the configured window", () => {
  clearRateLimits();
  assert.equal(consumeRateLimit("key", 2, 1000, 0).allowed, true);
  assert.equal(consumeRateLimit("key", 2, 1000, 1).allowed, true);
  const rejected = consumeRateLimit("key", 2, 1000, 2);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterMs, 998);
});

test("rate limiter resets after the time window", () => {
  clearRateLimits();
  consumeRateLimit("key", 1, 1000, 0);
  assert.equal(consumeRateLimit("key", 1, 1000, 1000).allowed, true);
});

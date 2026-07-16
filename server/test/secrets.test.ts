import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/utils/secrets";

test("provider secrets round-trip through authenticated encryption", () => {
  const previous = process.env.SECRETS_KEY;
  process.env.SECRETS_KEY = "test-encryption-key";
  try {
    const encrypted = encryptSecret("sk-example");
    assert.match(encrypted, /^enc:v1:/);
    assert.notEqual(encrypted, "sk-example");
    assert.equal(decryptSecret(encrypted), "sk-example");
  } finally {
    if (previous === undefined) delete process.env.SECRETS_KEY;
    else process.env.SECRETS_KEY = previous;
  }
});

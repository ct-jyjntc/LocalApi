import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("reserveUsage charges the matching time window and snapshots those rates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-price-windows-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "price-window-test-secret";

  const { initDb } = await import("../src/db");
  const { adjustWallet, getWallet, reserveUsage, upsertModelPrice } = await import("../src/services/billing");
  const { createUser } = await import("../src/services/users");
  const { createApiKey } = await import("../src/services/keys");

  try {
    initDb();
    const user = createUser({ username: "window-user", password: "password-123" });
    const key = createApiKey({ name: "window-key", user_id: user.id });
    adjustWallet(user.id, 10_000_000, "seed");
    upsertModelPrice({
      model: "timed-model",
      input_price_micros: 1_000_000,
      output_price_micros: 1_000_000,
      windows: [{
        start: "00:00",
        end: "24:00",
        days: [],
        input_price_micros: 2_000_000,
        output_price_micros: 4_000_000,
        cache_read_price_micros: 0,
        cache_write_price_micros: 0,
      }],
    });

    const reservation = reserveUsage({
      requestId: "window-request",
      userId: user.id,
      apiKeyId: key.id,
      model: "timed-model",
      estimate: { prompt: 1_000_000, completion: 1_000_000 },
      body: { model: "timed-model" },
    });

    assert.equal(reservation.price.input_price_micros, 2_000_000);
    assert.equal(reservation.price.output_price_micros, 4_000_000);
    assert.equal(reservation.price.active_window_index, 0);
    assert.equal(getWallet(user.id)?.reserved_micros, 6_000_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("wallet free models require ¥1 lifetime top-up; coding plans are unaffected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-free-model-gate-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "free-model-gate-secret";

  const { db, initDb, setSetting } = await import("../src/db");
  const { createUser } = await import("../src/services/users");
  const { createApiKey } = await import("../src/services/keys");
  const { beginRequestAccess, AccessError, clearAccessState } = await import("../src/services/access");
  const { createPlan, assignPlan } = await import("../src/services/plans");
  const { upsertModelPrice } = await import("../src/services/billing");

  try {
    initDb();
    upsertModelPrice({
      model: "deepseek-v4-flash-free",
      input_price_micros: 0,
      output_price_micros: 0,
    });
    upsertModelPrice({
      model: "paid-model",
      input_price_micros: 1_000_000,
      output_price_micros: 1_000_000,
    });

    const user = createUser({ username: "free-gate-user", password: "password-123" });
    const keyPublic = createApiKey({ name: "k", user_id: user.id });
    const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyPublic.id) as import("../src/db").ApiKey;
    clearAccessState();

    assert.throws(
      () => beginRequestAccess(key, "deepseek-v4-flash-free", { model: "deepseek-v4-flash-free" }, { billingMode: "wallet" }),
      (error) => error instanceof AccessError && error.code === "free_model_topup_required",
    );

    const paidOk = beginRequestAccess(key, "paid-model", { model: "paid-model" }, { billingMode: "wallet" });
    paidOk.release(1);

    const plan = createPlan({
      name: "Lite with free model",
      included_credits_micros: 1_000_000,
      allowed_models: ["deepseek-v4-flash-free"],
      rpm_limit: 10,
    });
    assignPlan(user.id, plan.id);
    clearAccessState();
    const codingOk = beginRequestAccess(
      key,
      "deepseek-v4-flash-free",
      { model: "deepseek-v4-flash-free" },
      { billingMode: "coding" },
    );
    codingOk.release(1);

    db.prepare("UPDATE wallet_accounts SET lifetime_topup_micros = 1_000_000 WHERE user_id = ?").run(user.id);
    clearAccessState();
    const topped = beginRequestAccess(key, "deepseek-v4-flash-free", { model: "deepseek-v4-flash-free" }, { billingMode: "wallet" });
    topped.release(1);

    db.prepare("UPDATE wallet_accounts SET lifetime_topup_micros = 0 WHERE user_id = ?").run(user.id);
    setSetting("wallet_free_model_topup_required", "false");
    clearAccessState();
    const disabled = beginRequestAccess(key, "deepseek-v4-flash-free", { model: "deepseek-v4-flash-free" }, { billingMode: "wallet" });
    disabled.release(1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

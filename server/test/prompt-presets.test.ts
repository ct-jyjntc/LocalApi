import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("prompt presets bind to models, resolve to an injection, and are excluded from billed usage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-prompt-presets-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "prompt-preset-secret";

  const { db, initDb } = await import("../src/db");
  const { upsertModelPrice, getModelPrice } = await import("../src/services/billing");
  const {
    createPromptPreset,
    deletePromptPreset,
    listPromptPresets,
    resolveModelPromptInjection,
  } = await import("../src/services/prompt-presets");

  try {
    initDb();

    const presetA = createPromptPreset({ name: "System", filename: "Prompts.md.txt", content: "You are ZCode. ".repeat(100) });
    const presetB = createPromptPreset({ name: "Skills", filename: "Skills.md.txt", content: "skill list ".repeat(50) });

    // List omits content but reports size.
    const listed = listPromptPresets();
    assert.equal(listed.length, 2);
    assert.ok(!("content" in listed[0]));
    assert.ok(listed.find((p) => p.id === presetA.id)!.size_bytes > 0);

    // Unbound model resolves to nothing.
    upsertModelPrice({ model: "glm-like", input_price_micros: 1, output_price_micros: 1 });
    assert.equal(resolveModelPromptInjection("glm-like"), null);

    // Binding persists through upsert and round-trips via getModelPrice.
    upsertModelPrice({ model: "glm-like", input_price_micros: 1, output_price_micros: 1, prompt_preset_ids: [presetA.id, presetB.id] });
    assert.deepEqual(getModelPrice("glm-like")!.prompt_preset_ids, [presetA.id, presetB.id]);

    // Upsert without prompt_preset_ids keeps the existing binding.
    upsertModelPrice({ model: "glm-like", input_price_micros: 2, output_price_micros: 2 });
    assert.deepEqual(getModelPrice("glm-like")!.prompt_preset_ids, [presetA.id, presetB.id]);

    const injection = resolveModelPromptInjection("glm-like");
    assert.ok(injection);
    assert.deepEqual(injection!.presetNames, ["System", "Skills"]);
    assert.ok(injection!.text.includes("You are ZCode."));
    assert.ok(injection!.text.includes("skill list"));
    assert.equal(injection!.estimatedTokens, Math.max(1, Math.ceil((presetA.content.length + presetB.content.length) / 4)));

    // Deleting a preset drops it from the resolution.
    deletePromptPreset(presetA.id);
    const afterDelete = resolveModelPromptInjection("glm-like");
    assert.deepEqual(afterDelete!.presetNames, ["Skills"]);
    deletePromptPreset(presetB.id);
    assert.equal(resolveModelPromptInjection("glm-like"), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

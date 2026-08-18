import { v4 as uuid } from "uuid";
import { db, PromptPreset } from "../db";
import { nowIso } from "../utils/time";

export type PromptPresetSummary = Omit<PromptPreset, "content"> & { size_bytes: number };

function toSummary(row: PromptPreset): PromptPresetSummary {
  const { content, ...rest } = row;
  return { ...rest, size_bytes: Buffer.byteLength(content, "utf8") };
}

export function listPromptPresets(): PromptPresetSummary[] {
  return (db.prepare("SELECT * FROM prompt_presets ORDER BY name").all() as PromptPreset[]).map(toSummary);
}

export function getPromptPreset(id: string): PromptPreset | null {
  return (db.prepare("SELECT * FROM prompt_presets WHERE id = ?").get(id) as PromptPreset | undefined) ?? null;
}

export function createPromptPreset(input: { name: string; filename?: string; content: string }): PromptPreset {
  const now = nowIso();
  const id = uuid();
  db.prepare(
    `INSERT INTO prompt_presets (id, name, filename, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.name.trim(), input.filename ?? "", input.content, now, now);
  return getPromptPreset(id)!;
}

export function deletePromptPreset(id: string) {
  return db.prepare("DELETE FROM prompt_presets WHERE id = ?").run(id).changes > 0;
}

export type ModelPromptInjection = {
  /** Combined system-prompt text to prepend to the request. */
  text: string;
  /** Rough prompt-token count (chars/4, same heuristic as billing estimates). */
  estimatedTokens: number;
  presetNames: string[];
};

/**
 * Resolve the prompt presets bound to a public model name into a single
 * system message. These tokens are injected by the relay and must NOT be
 * billed to the user — the proxy subtracts estimatedTokens at settlement.
 */
export function resolveModelPromptInjection(model: string): ModelPromptInjection | null {
  const row = db.prepare("SELECT prompt_preset_ids FROM model_prices WHERE model = ?").get(model) as
    | { prompt_preset_ids: string }
    | undefined;
  if (!row) return null;
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.prompt_preset_ids);
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
  if (ids.length === 0) return null;

  const stmt = db.prepare("SELECT name, content FROM prompt_presets WHERE id = ?");
  const parts: string[] = [];
  const names: string[] = [];
  let chars = 0;
  for (const id of ids) {
    const preset = stmt.get(id) as { name: string; content: string } | undefined;
    if (!preset || !preset.content.trim()) continue;
    parts.push(preset.content);
    names.push(preset.name);
    chars += preset.content.length;
  }
  if (parts.length === 0) return null;
  return {
    text: parts.join("\n\n"),
    estimatedTokens: Math.max(1, Math.ceil(chars / 4)),
    presetNames: names,
  };
}

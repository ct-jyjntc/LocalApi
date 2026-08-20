/**
 * Normalize OpenAI-compatible chat completion request bodies so client SDKs
 * (especially Pi coding agent) work against non-OpenAI upstreams (Z.ai /
 * DeepSeek-style pools) that reject OpenAI-only shapes.
 *
 * Known Pi / OpenAI SDK incompatibilities we fix here:
 * - role "developer" → "system"  (Pi sets this when model.reasoning=true)
 * - thinking: true|false|"enabled"|"disabled" → { type: "enabled"|"disabled" }
 * - strip empty/null OpenAI-only knobs that some gateways reject when present
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeThinking(value: unknown): unknown {
  if (value === true || value === "enabled" || value === "on" || value === 1) {
    return { type: "enabled" };
  }
  if (value === false || value === "disabled" || value === "off" || value === 0) {
    return { type: "disabled" };
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "enabled" || lower === "on" || lower === "true") return { type: "enabled" };
    if (lower === "disabled" || lower === "off" || lower === "false") return { type: "disabled" };
  }
  if (isObject(value)) {
    const type = value.type;
    if (type === true || type === "enabled" || type === "on") {
      return { ...value, type: "enabled" };
    }
    if (type === false || type === "disabled" || type === "off") {
      return { ...value, type: "disabled" };
    }
  }
  return value;
}

function normalizeMessageRole(role: unknown): unknown {
  if (typeof role !== "string") return role;
  // OpenAI o-series / Pi reasoning path uses "developer"; most China gateways only
  // accept system/user/assistant/tool/function.
  if (role === "developer") return "system";
  return role;
}

function normalizeMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!isObject(msg)) return msg;
    const role = normalizeMessageRole(msg.role);
    if (role === msg.role) return msg;
    return { ...msg, role };
  });
}

/**
 * Fields that pure OpenAI clients sometimes send and that certain upstream
 * pools either ignore harmlessly or reject. Only drop ones we have verified as
 * safe-to-strip / known-bad; leave everything else untouched.
 */
const STRIP_WHEN_PRESENT = new Set<string>([
  // Pi sets store:false on OpenAI-compat paths; most non-OpenAI pools ignore it,
  // but a few return "invalid arguments". Dropping is safer than rewriting.
  "store",
  // OpenAI prompt-cache knobs — not supported by Z.ai / DeepSeek-style pools.
  "prompt_cache_key",
  "prompt_cache_retention",
]);

export type NormalizeResult = {
  body: unknown;
  changed: boolean;
  changes: string[];
};

/**
 * Canonical reasoning-effort levels, ordered low → high. Providers declare
 * per-model which of these they accept (providers.model_efforts); the relay
 * uses the list for validation, /v1/models advertising, and UI editors.
 */
export const REASONING_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export function normalizeOpenAICompatBody(body: unknown, path: string): NormalizeResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body, changed: false, changes: [] };
  }
  if (path !== "/v1/chat/completions" && path !== "/v1/completions") {
    return { body, changed: false, changes: [] };
  }

  const record = { ...(body as JsonObject) };
  const changes: string[] = [];

  if (path === "/v1/chat/completions" && "messages" in record) {
    const before = JSON.stringify(record.messages);
    record.messages = normalizeMessages(record.messages);
    if (JSON.stringify(record.messages) !== before) {
      changes.push("messages.role:developer→system");
    }
  }

  if ("thinking" in record) {
    const before = JSON.stringify(record.thinking);
    record.thinking = normalizeThinking(record.thinking);
    if (JSON.stringify(record.thinking) !== before) {
      changes.push("thinking:normalized");
    }
  }

  // enable_thinking is a Qwen-style alias; leave it if present (some pools honor it).
  // Only rewrite boolean thinking above.

  for (const key of STRIP_WHEN_PRESENT) {
    if (key in record) {
      delete record[key];
      changes.push(`strip:${key}`);
    }
  }

  // max_completion_tokens is accepted by the Z.ai pool we proxy; keep it.
  // reasoning_effort is accepted; keep it.

  return {
    body: record,
    changed: changes.length > 0,
    changes,
  };
}

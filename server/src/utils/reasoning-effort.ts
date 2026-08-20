/**
 * Per-protocol reasoning-effort locations.
 *
 * The relay speaks three upstream dialects, and each carries the thinking
 * effort knob in a different place:
 * - openai-completions  (/v1/chat/completions): top-level `reasoning_effort`
 * - openai-responses    (/v1/responses):        `reasoning.effort`
 * - anthropic-messages  (/v1/messages):         `output_config.effort`
 *   (Anthropic effort parameter); many Anthropic-compatible gateways also
 *   accept a top-level `reasoning_effort`, so that is honored as a fallback.
 *
 * Provider per-model effort mappings (providers.model_efforts) are matched
 * against the extracted value and rewritten back into the SAME location the
 * client used, so a failover to another provider never changes dialects.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type EffortLocation = "top" | "reasoning" | "output_config";

/**
 * Locations probed for a path, in priority order. The first location that
 * holds a non-empty string wins for extraction; rewriting updates every
 * location that currently holds a string so duplicates cannot disagree.
 */
function effortLocations(path: string): EffortLocation[] {
  if (path === "/v1/responses") return ["reasoning", "top"];
  if (path === "/v1/messages") return ["output_config", "top"];
  // /v1/chat/completions and anything else: the flat OpenAI field.
  return ["top"];
}

function readLocation(record: JsonObject, location: EffortLocation): string | null {
  if (location === "top") {
    return typeof record.reasoning_effort === "string" && record.reasoning_effort.trim()
      ? record.reasoning_effort
      : null;
  }
  const container = location === "reasoning" ? record.reasoning : record.output_config;
  if (!isObject(container)) return null;
  const effort = container.effort;
  return typeof effort === "string" && effort.trim() ? effort : null;
}

/**
 * The client-requested reasoning effort for this request, wherever the
 * protocol for `path` puts it. Null when the request carries none.
 */
export function extractRequestEffort(body: unknown, path: string): string | null {
  if (!isObject(body)) return null;
  for (const location of effortLocations(path)) {
    const effort = readLocation(body, location);
    if (effort) return effort;
  }
  return null;
}

/**
 * Rewrite the request's reasoning effort to `effort`, in place-wise fashion:
 * every location the protocol recognizes AND that currently holds a string is
 * updated. Locations the client did not set are left absent (adding new knobs
 * could trip strict upstreams). Returns the original body untouched when
 * nothing needed changing.
 */
export function rewriteRequestEffort(
  body: unknown,
  path: string,
  effort: string,
): { body: unknown; changed: boolean } {
  if (!isObject(body)) return { body, changed: false };
  let next: JsonObject = body;
  let changed = false;
  for (const location of effortLocations(path)) {
    if (readLocation(next, location) === null) continue;
    if (location === "top") {
      if (next.reasoning_effort !== effort) {
        next = { ...next, reasoning_effort: effort };
        changed = true;
      }
      continue;
    }
    const key = location === "reasoning" ? "reasoning" : "output_config";
    const container = next[key];
    if (!isObject(container) || container.effort === effort) continue;
    next = { ...next, [key]: { ...container, effort } };
    changed = true;
  }
  return { body: changed ? next : body, changed };
}

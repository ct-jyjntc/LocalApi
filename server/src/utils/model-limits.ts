import { getModelPrice } from "../services/billing";

export class ModelLimitError extends Error {
  status: number;
  code: string;
  type: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.type = "invalid_request_error";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function estimatePromptTokens(body: JsonObject): number {
  // Estimate the entire request body, not just messages/prompt/input.
  // Fields like instructions, system, tools, functions all consume context.
  const chars = JSON.stringify(body).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function clampPositiveInt(value: unknown, cap: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(cap, Math.floor(n)));
}

export type ApplyModelLimitsResult = {
  body: unknown;
  changed: boolean;
  changes: string[];
};

export function applyModelLimits(body: unknown, path: string): ApplyModelLimitsResult {
  if (!isObject(body)) return { body, changed: false, changes: [] };
  // Only /v1/chat/completions is allowed through the proxy, so this guard
  // is effectively a chat-only check. Kept general in case new routes are added.
  if (!path.startsWith("/v1/")) {
    return { body, changed: false, changes: [] };
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return { body, changed: false, changes: [] };
  const price = getModelPrice(model);
  if (!price) return { body, changed: false, changes: [] };

  const record = { ...body };
  const changes: string[] = [];
  const maxOutput = Number(price.max_output_tokens) || 0;
  const contextWindow = Number(price.context_window) || 0;

  if (maxOutput > 0) {
    for (const key of ["max_tokens", "max_completion_tokens", "maxOutputTokens"] as const) {
      if (key in record) {
        const next = clampPositiveInt(record[key], maxOutput);
        if (next !== undefined && next !== Number(record[key])) {
          record[key] = next;
          changes.push(`clamp:${key}`);
        }
      }
    }
    if (!("max_tokens" in record) && !("max_completion_tokens" in record) && !("maxOutputTokens" in record)) {
      record.max_tokens = maxOutput;
      changes.push("default:max_tokens");
    }
  }

  if (contextWindow > 0) {
    const promptTokens = estimatePromptTokens(record);
    const requestedOut = Number(record.max_tokens ?? record.max_completion_tokens ?? record.maxOutputTokens ?? 0);
    const reservedOut = Number.isFinite(requestedOut) && requestedOut > 0 ? Math.floor(requestedOut) : 0;
    if (promptTokens > contextWindow) {
      throw new ModelLimitError(
        400,
        "context_length_exceeded",
        `This model's maximum context length is ${contextWindow} tokens. Your request used about ${promptTokens} prompt tokens.`,
      );
    }
    if (promptTokens + reservedOut > contextWindow) {
      const allowedOut = Math.max(1, contextWindow - promptTokens);
      for (const key of ["max_tokens", "max_completion_tokens", "maxOutputTokens"] as const) {
        if (key in record) {
          const next = clampPositiveInt(record[key], allowedOut);
          if (next !== undefined && next !== Number(record[key])) {
            record[key] = next;
            changes.push(`clamp:${key}:context`);
          }
        }
      }
      if (!("max_tokens" in record) && !("max_completion_tokens" in record) && !("maxOutputTokens" in record)) {
        record.max_tokens = allowedOut;
        changes.push("default:max_tokens:context");
      }
    }
  }

  return { body: record, changed: changes.length > 0, changes };
}

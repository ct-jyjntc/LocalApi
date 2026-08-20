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

  // Each dialect names the output cap differently: chat/completions and
  // anthropic-messages use max_tokens (or OpenAI's max_completion_tokens),
  // the responses API uses max_output_tokens. Clamp all of them, and when a
  // default must be injected use the dialect's own spelling so strict
  // upstreams never see a field they do not know.
  const OUTPUT_KEYS = ["max_tokens", "max_completion_tokens", "maxOutputTokens", "max_output_tokens"] as const;
  const defaultOutputKey = path === "/v1/responses" ? "max_output_tokens" : "max_tokens";
  const hasOutputKey = (r: JsonObject) => OUTPUT_KEYS.some((key) => key in r);

  if (maxOutput > 0) {
    for (const key of OUTPUT_KEYS) {
      if (key in record) {
        const next = clampPositiveInt(record[key], maxOutput);
        if (next !== undefined && next !== Number(record[key])) {
          record[key] = next;
          changes.push(`clamp:${key}`);
        }
      }
    }
    if (!hasOutputKey(record)) {
      record[defaultOutputKey] = maxOutput;
      changes.push(`default:${defaultOutputKey}`);
    }
  }

  if (contextWindow > 0) {
    const promptTokens = estimatePromptTokens(record);
    const requestedOut = Number(
      record.max_tokens ?? record.max_completion_tokens ?? record.maxOutputTokens ?? record.max_output_tokens ?? 0,
    );
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
      for (const key of OUTPUT_KEYS) {
        if (key in record) {
          const next = clampPositiveInt(record[key], allowedOut);
          if (next !== undefined && next !== Number(record[key])) {
            record[key] = next;
            changes.push(`clamp:${key}:context`);
          }
        }
      }
      if (!hasOutputKey(record)) {
        record[defaultOutputKey] = allowedOut;
        changes.push(`default:${defaultOutputKey}:context`);
      }
    }
  }

  return { body: record, changed: changes.length > 0, changes };
}

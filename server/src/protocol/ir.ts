/**
 * Protocol translation layer: lets a client speaking one dialect
 * (openai-completions / openai-responses / anthropic-messages) reach a
 * channel that only speaks another. Translation goes through a shared
 * intermediate representation (IR); streaming responses are translated as
 * incremental events so SSE framing is regenerated per target dialect.
 */

export type ProtocolId = "openai-completions" | "openai-responses" | "anthropic-messages";

export const PROTOCOL_IDS: ProtocolId[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

export const PROTOCOL_PATHS: Record<ProtocolId, string> = {
  "openai-completions": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  "anthropic-messages": "/v1/messages",
};

export function protocolForPath(path: string): ProtocolId | null {
  for (const [id, p] of Object.entries(PROTOCOL_PATHS)) {
    if (p === path) return id as ProtocolId;
  }
  return null;
}

// ---------- Request IR ----------

export type IrContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url?: string; mediaType?: string; data?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "thinking"; text: string };

export type IrMessage = {
  role: "system" | "user" | "assistant" | "tool";
  parts: IrContentPart[];
};

export type IrToolChoice = "auto" | "none" | "required" | { name: string };

export type IrRequest = {
  model?: string;
  messages: IrMessage[];
  tools?: { name: string; description?: string; parameters?: unknown }[];
  toolChoice?: IrToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  effort?: string;
};

// ---------- Response IR ----------

export type IrUsage = {
  prompt: number;
  completion: number;
  reasoning?: number;
  cached?: number;
  total?: number;
};

export type IrFinishReason = "stop" | "tool_calls" | "length" | string;

export type IrResponse = {
  model?: string;
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: IrFinishReason;
  usage?: IrUsage;
};

// ---------- Streaming incremental events ----------

export type StreamEvent =
  | { type: "start"; model?: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_args"; index: number; delta: string }
  | { type: "finish"; reason: IrFinishReason }
  | { type: "usage"; usage: IrUsage }
  | { type: "done" };

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function toIrUsage(raw: unknown): IrUsage | null {
  if (!isObject(raw)) return null;
  const prompt = asNumber(raw.prompt_tokens ?? raw.input_tokens) ?? 0;
  const completion = asNumber(raw.completion_tokens ?? raw.output_tokens) ?? 0;
  const completionDetails = isObject(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : isObject(raw.output_tokens_details)
      ? raw.output_tokens_details
      : {};
  const promptDetails = isObject(raw.prompt_tokens_details)
    ? raw.prompt_tokens_details
    : isObject(raw.input_tokens_details)
      ? raw.input_tokens_details
      : {};
  const reasoning = asNumber(raw.reasoning_tokens ?? completionDetails.reasoning_tokens) ?? 0;
  const cached = asNumber(raw.cached_tokens ?? promptDetails.cached_tokens ?? raw.cache_read_input_tokens) ?? 0;
  const total = asNumber(raw.total_tokens) ?? prompt + completion;
  return { prompt, completion, reasoning, cached, total };
}

export function fromIrUsage(
  usage: IrUsage,
  dialect: "openai" | "anthropic" | "responses",
): Record<string, unknown> {
  if (dialect === "anthropic") {
    return {
      input_tokens: usage.prompt,
      output_tokens: usage.completion,
      ...(usage.cached ? { cache_read_input_tokens: usage.cached } : {}),
    };
  }
  if (dialect === "responses") {
    return {
      input_tokens: usage.prompt,
      output_tokens: usage.completion,
      total_tokens: usage.total ?? usage.prompt + usage.completion,
      ...(usage.cached ? { input_tokens_details: { cached_tokens: usage.cached } } : {}),
      ...(usage.reasoning ? { output_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
    };
  }
  return {
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
    total_tokens: usage.total ?? usage.prompt + usage.completion,
    ...(usage.reasoning ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
    ...(usage.cached ? { prompt_tokens_details: { cached_tokens: usage.cached } } : {}),
  };
}

export function mapFinishToOpenAI(reason: IrFinishReason): string {
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "completed") return "stop";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens" || reason === "incomplete") return "length";
  return reason || "stop";
}

export function mapFinishToAnthropic(reason: IrFinishReason): string {
  if (reason === "stop" || reason === "completed") return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length" || reason === "incomplete") return "max_tokens";
  return reason || "end_turn";
}

/** responses-API terminal status: completed vs incomplete. */
export function mapFinishToResponses(reason: IrFinishReason): { status: string; finishNote?: string } {
  if (reason === "length" || reason === "max_tokens") {
    return { status: "incomplete", finishNote: "max_output_tokens" };
  }
  return { status: "completed" };
}

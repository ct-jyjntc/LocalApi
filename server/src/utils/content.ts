import { StringDecoder } from "string_decoder";

export type ExtractedIO = {
  input_text: string | null;
  output_text: string | null;
  reasoning_text: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  stream: boolean;
};

function clamp(text: string | null | undefined): string | null {
  if (text == null) return null;
  const s = String(text);
  if (!s) return null;
  return s;
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
          if (obj.type === "text" && typeof obj.text === "string") return obj.text;
          if (obj.type === "image_url") return "[image]";
          if (obj.type === "input_audio") return "[audio]";
        }
        return null;
      })
      .filter(Boolean) as string[];
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function messageContent(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return asText(msg);
  const m = msg as Record<string, unknown>;
  if (m.content !== undefined) return asText(m.content);
  if (typeof m.text === "string") return m.text;
  return null;
}

export function extractInput(body: unknown, path: string): string | null {
  if (!body) return null;
  if (typeof body === "string") return clamp(body);

  if (typeof body !== "object") return clamp(String(body));
  const b = body as Record<string, unknown>;

  // Chat completions
  if (Array.isArray(b.messages)) {
    const lines = (b.messages as unknown[])
      .map((msg) => {
        if (!msg || typeof msg !== "object") return null;
        const m = msg as Record<string, unknown>;
        const role = typeof m.role === "string" ? m.role : "unknown";
        const content = messageContent(m);
        if (!content) return null;
        return `${role}: ${content}`;
      })
      .filter(Boolean) as string[];
    if (lines.length) return clamp(lines.join("\n"));
  }

  // Completions / embeddings / images
  if (b.prompt !== undefined) {
    const p = asText(b.prompt);
    if (p) return clamp(p);
  }
  if (b.input !== undefined) {
    const input = asText(b.input);
    if (input) return clamp(input);
  }

  // Responses API style
  if (b.input !== undefined || path.includes("/responses")) {
    const input = asText(b.input);
    if (input) return clamp(input);
  }

  // Fallback: compact JSON without secrets
  try {
    const copy = { ...b };
    delete copy.api_key;
    delete copy.authorization;
    return clamp(JSON.stringify(copy));
  } catch {
    return null;
  }
}

function collectReasoningFromMessage(msg: Record<string, unknown>): string | null {
  const parts: string[] = [];

  if (typeof msg.reasoning === "string") parts.push(msg.reasoning);
  if (typeof msg.reasoning_content === "string") parts.push(msg.reasoning_content);
  if (msg.reasoning && typeof msg.reasoning === "object") {
    const r = msg.reasoning as Record<string, unknown>;
    if (typeof r.content === "string") parts.push(r.content);
    if (typeof r.text === "string") parts.push(r.text);
  }

  // content parts may include reasoning/thinking blocks
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (
        (p.type === "reasoning" ||
          p.type === "thinking" ||
          p.type === "reasoning_content") &&
        typeof p.text === "string"
      ) {
        parts.push(p.text);
      }
      if (typeof p.reasoning === "string") parts.push(p.reasoning);
    }
  }

  return parts.length ? parts.join("\n") : null;
}

export function extractFromResponse(
  bodyText: string | Buffer | null | undefined,
): Pick<
  ExtractedIO,
  | "output_text"
  | "reasoning_text"
  | "prompt_tokens"
  | "completion_tokens"
  | "reasoning_tokens"
  | "cached_tokens"
  | "total_tokens"
> {
  const empty = {
    output_text: null as string | null,
    reasoning_text: null as string | null,
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
  };

  if (bodyText == null) return empty;
  const text =
    typeof bodyText === "string" ? bodyText : bodyText.toString("utf8");
  if (!text) return empty;

  // SSE / stream dump: try to stitch delta content
  if (text.includes("data:")) {
    return extractFromSse(text);
  }

  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    return extractFromJson(data, text);
  } catch {
    return { ...empty, output_text: clamp(text) };
  }
}

function extractFromJson(
  data: Record<string, unknown>,
  rawFallback: string,
): ReturnType<typeof extractFromResponse> {
  let output: string | null = null;
  let reasoning: string | null = null;

  // chat.completion
  if (Array.isArray(data.choices) && data.choices.length) {
    const choice = data.choices[0] as Record<string, unknown>;
    if (choice.message && typeof choice.message === "object") {
      const msg = choice.message as Record<string, unknown>;
      const content = messageContent(msg);
      output = content && content.trim() ? content : null;
      reasoning = collectReasoningFromMessage(msg);
    } else if (choice.delta && typeof choice.delta === "object") {
      const delta = choice.delta as Record<string, unknown>;
      const content = messageContent(delta);
      output = content && content.trim() ? content : null;
      reasoning = collectReasoningFromMessage(delta);
    } else if (typeof choice.text === "string" && choice.text.trim()) {
      output = choice.text;
    }
    if (!reasoning && typeof choice.reasoning === "string") {
      reasoning = choice.reasoning;
    }
  }

  // embeddings: summarize
  if (!output && Array.isArray(data.data)) {
    const first = data.data[0] as Record<string, unknown> | undefined;
    if (first?.embedding && Array.isArray(first.embedding)) {
      output = `[embedding dims=${(first.embedding as unknown[]).length}]`;
    } else if (first?.url) {
      output = String(first.url);
    } else if (first?.b64_json) {
      output = "[image b64]";
    }
  }

  // responses API
  if (!output && typeof data.output_text === "string") {
    output = data.output_text;
  }
  if (!output && Array.isArray(data.output)) {
    const texts: string[] = [];
    const reasons: string[] = [];
    for (const item of data.output as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (Array.isArray(it.content)) {
        for (const c of it.content) {
          if (!c || typeof c !== "object") continue;
          const part = c as Record<string, unknown>;
          if (typeof part.text === "string") {
            if (part.type === "reasoning" || part.type === "thinking") {
              reasons.push(part.text);
            } else {
              texts.push(part.text);
            }
          }
        }
      }
    }
    if (texts.length) output = texts.join("\n");
    if (reasons.length) reasoning = reasons.join("\n");
  }

  // Anthropic Messages API
  if (Array.isArray(data.content)) {
    const texts: string[] = [];
    const reasons: string[] = [];
    const tools: string[] = [];
    for (const item of data.content as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      if (part.type === "thinking" && typeof part.thinking === "string") reasons.push(part.thinking);
      if (part.type === "tool_use") tools.push(`[tool] ${String(part.name || "unknown")}\n${JSON.stringify(part.input ?? {})}`);
    }
    if (!output && (texts.length || tools.length)) output = [...texts, ...tools].join("\n");
    if (!reasoning && reasons.length) reasoning = reasons.join("\n");
  }

  if (!output && typeof data.error === "object" && data.error) {
    const err = data.error as Record<string, unknown>;
    output = typeof err.message === "string" ? err.message : JSON.stringify(err);
  }

  // Prefer empty over dumping raw JSON when we successfully parsed the envelope
  if (!output && !reasoning && !data.choices && !data.usage) {
    output = clamp(rawFallback);
  }

  const usage = parseUsage(data.usage);

  return {
    output_text: clamp(output),
    reasoning_text: clamp(reasoning),
    ...usage,
  };
}

function parseUsage(raw: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
} {
  const usage =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const completionDetails =
    usage.completion_tokens_details &&
    typeof usage.completion_tokens_details === "object"
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : usage.output_tokens_details &&
          typeof usage.output_tokens_details === "object"
        ? (usage.output_tokens_details as Record<string, unknown>)
        : {};
  const promptDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : usage.input_tokens_details && typeof usage.input_tokens_details === "object"
        ? (usage.input_tokens_details as Record<string, unknown>)
        : {};

  const prompt_tokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion_tokens =
    Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const reasoning_tokens =
    Number(
      usage.reasoning_tokens ??
        completionDetails.reasoning_tokens ??
        completionDetails.reasoning ??
        0,
    ) || 0;
  const cached_tokens =
    Number(
      usage.cached_tokens ??
        promptDetails.cached_tokens ??
        promptDetails.cache_read_input_tokens ??
        usage.cache_read_input_tokens ??
        0,
    ) || 0;
  const total_tokens =
    Number(usage.total_tokens ?? prompt_tokens + completion_tokens) || 0;

  return {
    prompt_tokens,
    completion_tokens,
    reasoning_tokens,
    cached_tokens,
    total_tokens,
  };
}

function mergeUsage(current: unknown, next: unknown): unknown {
  if (!next || typeof next !== "object") return current;
  const left = current && typeof current === "object" ? current as Record<string, unknown> : {};
  const right = next as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value && typeof value === "object" && !Array.isArray(value)) merged[key] = mergeUsage(left[key], value);
    else if (typeof value === "number" && typeof left[key] === "number") merged[key] = Math.max(left[key] as number, value);
    else if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function extractFromSse(text: string): ReturnType<typeof extractFromResponse> {
  const contents: string[] = [];
  const reasons: string[] = [];
  let usageRaw: unknown = null;
  const toolCalls = new Map<number, { name: string; arguments: string }>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (data.usage && typeof data.usage === "object") {
        usageRaw = mergeUsage(usageRaw, data.usage);
      }
      if (data.message && typeof data.message === "object") {
        const message = data.message as Record<string, unknown>;
        if (message.usage && typeof message.usage === "object") usageRaw = mergeUsage(usageRaw, message.usage);
      }
      if (Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0] as Record<string, unknown>;
        const delta =
          (choice.delta as Record<string, unknown> | undefined) ||
          (choice.message as Record<string, unknown> | undefined) ||
          {};
        const c = messageContent(delta);
        if (c) contents.push(c);
        const r = collectReasoningFromMessage(delta);
        if (r) reasons.push(r);
        if (typeof choice.text === "string") contents.push(choice.text);
      }
      if (data.delta && typeof data.delta === "object") {
        const delta = data.delta as Record<string, unknown>;
        if (typeof delta.text === "string") contents.push(delta.text);
        if (typeof delta.thinking === "string") reasons.push(delta.thinking);
      }
    } catch {
      // ignore bad chunks
    }
  }

  return {
    output_text: clamp(contents.join("") || null),
    reasoning_text: clamp(reasons.join("") || null),
    ...parseUsage(usageRaw),
  };
}

export type ResponseLogCollector = {
  push: (chunk: Buffer) => void;
  finish: () => ReturnType<typeof extractFromResponse>;
};

function isTextualResponse(contentType: string): boolean {
  if (!contentType) return true;
  return (
    contentType.startsWith("application/json") ||
    contentType.includes("+json") ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("x-www-form-urlencoded")
  );
}

export function createResponseLogCollector(params: {
  stream: boolean;
  contentType?: string | null;
}): ResponseLogCollector {
  const contentType = (params.contentType || "").toLowerCase();
  const sse = params.stream || /\btext\/event-stream\b/.test(contentType);

  if (!sse) {
    const chunks: Buffer[] = [];
    const textual = isTextualResponse(contentType);
    return {
      push: (chunk) => {
        if (textual) chunks.push(Buffer.from(chunk));
      },
      finish: () =>
        textual ? extractFromResponse(Buffer.concat(chunks)) : extractFromResponse(null),
    };
  }

  const decoder = new StringDecoder("utf8");
  const contents: string[] = [];
  const reasons: string[] = [];
  let usageRaw: unknown = null;
  const toolCalls = new Map<number, { name: string; arguments: string }>();
  let pending = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (data.usage && typeof data.usage === "object") {
        usageRaw = mergeUsage(usageRaw, data.usage);
        const billing = (data.usage as Record<string, unknown>).billing_usage as Record<string, unknown> | undefined;
        if (billing?.openai_usage) usageRaw = mergeUsage(usageRaw, billing.openai_usage);
      }
      if (data.response && typeof data.response === "object") {
        const response = data.response as Record<string, unknown>;
        if (response.usage && typeof response.usage === "object") {
          usageRaw = mergeUsage(usageRaw, response.usage);
        }
      }
      if (data.message && typeof data.message === "object") {
        const message = data.message as Record<string, unknown>;
        if (message.usage && typeof message.usage === "object") usageRaw = mergeUsage(usageRaw, message.usage);
      }

      if (Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0] as Record<string, unknown>;
        const delta =
          (choice.delta as Record<string, unknown> | undefined) ||
          (choice.message as Record<string, unknown> | undefined) ||
          {};
        const content = messageContent(delta);
        if (content) contents.push(content);
        const reasoning = collectReasoningFromMessage(delta);
        if (reasoning) reasons.push(reasoning);
        if (typeof choice.text === "string") contents.push(choice.text);
        const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : Array.isArray((choice.message as Record<string, unknown> | undefined)?.tool_calls) ? (choice.message as Record<string, unknown>).tool_calls as unknown[] : [];
        for (const rawCall of calls) {
          if (!rawCall || typeof rawCall !== "object") continue;
          const call = rawCall as Record<string, unknown>;
          const index = Number(call.index ?? 0) || 0;
          const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
          const current = toolCalls.get(index) || { name: "", arguments: "" };
          if (typeof fn.name === "string" && fn.name) current.name = fn.name;
          if (typeof fn.arguments === "string") current.arguments += fn.arguments;
          toolCalls.set(index, current);
        }
      }

      const eventType = typeof data.type === "string" ? data.type : "";
      if (typeof data.delta === "string") {
        if (/reasoning|thinking/.test(eventType)) reasons.push(data.delta);
        else if (/output_text|content/.test(eventType)) contents.push(data.delta);
      }
      if (data.delta && typeof data.delta === "object") {
        const delta = data.delta as Record<string, unknown>;
        if (typeof delta.text === "string") contents.push(delta.text);
        if (typeof delta.thinking === "string") reasons.push(delta.thinking);
        if (typeof delta.partial_json === "string") {
          const index = Number(data.index ?? 0) || 0;
          const current = toolCalls.get(index) || { name: "tool", arguments: "" };
          current.arguments += delta.partial_json;
          toolCalls.set(index, current);
        }
      }
      if (data.content_block && typeof data.content_block === "object") {
        const block = data.content_block as Record<string, unknown>;
        if (block.type === "tool_use") toolCalls.set(Number(data.index ?? 0) || 0, { name: String(block.name || "tool"), arguments: block.input ? JSON.stringify(block.input) : "" });
      }
    } catch {
      // Ignore malformed upstream events while preserving the live response.
    }
  };

  const consumeText = (text: string, flush = false) => {
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) consumeLine(line);
    if (flush && pending) consumeLine(pending);
  };

  return {
    push: (chunk) => consumeText(decoder.write(chunk)),
    finish: () => {
      consumeText(decoder.end(), true);
      const tools = [...toolCalls.values()].map((call) => `[tool] ${call.name || "unknown"}\n${call.arguments}`).join("\n");
      return {
        output_text: clamp([contents.join(""), tools].filter(Boolean).join("\n") || null),
        reasoning_text: clamp(reasons.join("") || null),
        ...parseUsage(usageRaw),
      };
    },
  };
}

export function extractIO(params: {
  path: string;
  body?: unknown;
  responseBody?: string | Buffer | null;
  stream?: boolean;
}): ExtractedIO {
  const input_text = extractInput(params.body, params.path);
  const fromRes = extractFromResponse(params.responseBody);
  return {
    input_text,
    stream: Boolean(params.stream),
    ...fromRes,
  };
}

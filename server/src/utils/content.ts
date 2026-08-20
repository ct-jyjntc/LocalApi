import { StringDecoder } from "string_decoder";
import fs from "fs";
import { DiskTextWriter, LOG_PREVIEW_CHARS } from "../services/log-bodies";

export type ExtractedIO = {
  input_text: string | null;
  output_text: string | null;
  reasoning_text: string | null;
  input_file?: string | null;
  output_file?: string | null;
  reasoning_file?: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  stream: boolean;
};

function clamp(text: string | null | undefined, max = LOG_PREVIEW_CHARS): string | null {
  if (text == null) return null;
  const s = String(text);
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
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
          // Nested content arrays (responses-API input items, anthropic
          // blocks) recurse so their text parts are not lost.
          if (Array.isArray(obj.content)) return asText(obj.content);
          if (obj.type === "text" && typeof obj.text === "string") return obj.text;
          if (obj.type === "image_url" || obj.type === "input_image") return "[image]";
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

export function extractInputToDisk(body: unknown, pathName: string) {
  const preview = extractInput(body, pathName);
  if (!preview) return { preview: null as string | null, file: null as string | null };
  const writer = new DiskTextWriter("input");
  if (typeof body === "string") {
    writer.push(body);
  } else if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.messages)) {
      for (const msg of b.messages as unknown[]) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        const role = typeof m.role === "string" ? m.role : "unknown";
        const content = messageContent(m);
        if (!content) continue;
        writer.push(`${role}: ${content}\n`);
      }
    } else {
      writer.push(preview);
    }
  } else {
    writer.push(preview);
  }
  return { preview: writer.preview || preview, file: writer.close() };
}

export function extractInput(body: unknown, path: string): string | null {
  if (!body) return null;
  if (typeof body === "string") return clamp(body);

  if (typeof body !== "object") return clamp(String(body));
  const b = body as Record<string, unknown>;

  // Chat completions
  if (Array.isArray(b.messages)) {
    const lines: string[] = [];
    let used = 0;
    for (const msg of b.messages as unknown[]) {
      if (used >= LOG_PREVIEW_CHARS) break;
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "unknown";
      const content = messageContent(m);
      if (!content) continue;
      const line = `${role}: ${content}`;
      lines.push(line);
      used += line.length + 1;
    }
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

  // Anthropic Messages API
  if (Array.isArray(data.content)) {    const texts: string[] = [];
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

  // OpenAI Responses API: top-level output[] holds message items whose
  // content[] carries output_text parts, plus reasoning items with summaries.
  if (Array.isArray(data.output)) {
    const texts: string[] = [];
    const reasons: string[] = [];
    const tools: string[] = [];
    for (const item of data.output as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const part = item as Record<string, unknown>;
      if (part.type === "message" && Array.isArray(part.content)) {
        for (const block of part.content as unknown[]) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
            texts.push(b.text);
          }
        }
      } else if (part.type === "reasoning") {
        const summary = Array.isArray(part.summary) ? part.summary : [];
        for (const s of summary) {
          if (s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string") {
            reasons.push((s as Record<string, unknown>).text as string);
          }
        }
        if (Array.isArray(part.content)) {
          for (const c of part.content as unknown[]) {
            if (c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string") {
              reasons.push((c as Record<string, unknown>).text as string);
            }
          }
        }
      } else if (part.type === "function_call") {
        tools.push(`[tool] ${String(part.name || "unknown")}\n${String(part.arguments ?? "")}`);
      }
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
      // responses-API terminal events (response.completed / .incomplete)
      // carry the full response object, usage included.
      if (data.response && typeof data.response === "object") {
        const response = data.response as Record<string, unknown>;
        if (response.usage && typeof response.usage === "object") usageRaw = mergeUsage(usageRaw, response.usage);
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
      if (data.error && typeof data.error === "object") {
        const err = data.error as Record<string, unknown>;
        const message = typeof err.message === "string" ? err.message : JSON.stringify(err);
        if (message) contents.push(message);
      }
    } catch {
      // ignore bad chunks
    }
  }

  return {
    output_text: clamp(contents.join("") || (text.includes("{") ? text.slice(0, 2000) : null)),
    reasoning_text: clamp(reasons.join("") || null),
    ...parseUsage(usageRaw),
  };
}

export type ResponseLogCollector = {
  push: (chunk: Buffer) => void;
  finish: () => ReturnType<typeof extractFromResponse> & {
    output_file?: string | null;
    reasoning_file?: string | null;
  };
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
    const writer = new DiskTextWriter("output");
    const textual = isTextualResponse(contentType);
    return {
      push: (chunk) => {
        if (textual) writer.push(chunk.toString("utf8"));
      },
      finish: () => {
        const file = writer.close();
        let extracted = extractFromResponse(null);
        if (textual && file && writer.bytes > 0) {
          try {
            extracted = extractFromResponse(fs.readFileSync(file, "utf8"));
          } catch {
            extracted = extractFromResponse(writer.preview);
          }
        }
        return {
          ...extracted,
          output_text: extracted.output_text || writer.preview || null,
          output_file: file,
        };
      },
    };
  }

  const decoder = new StringDecoder("utf8");
  const outputWriter = new DiskTextWriter("output");
  const reasonWriter = new DiskTextWriter("reasoning");
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
      if (data.message && typeof data.message === "object") {
        const message = data.message as Record<string, unknown>;
        if (message.usage && typeof message.usage === "object") usageRaw = mergeUsage(usageRaw, message.usage);
      }
      // responses-API terminal events carry the full response object.
      if (data.response && typeof data.response === "object") {
        const response = data.response as Record<string, unknown>;
        if (response.usage && typeof response.usage === "object") usageRaw = mergeUsage(usageRaw, response.usage);
      }

      if (Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0] as Record<string, unknown>;
        const delta =
          (choice.delta as Record<string, unknown> | undefined) ||
          (choice.message as Record<string, unknown> | undefined) ||
          {};
        const content = messageContent(delta);
        if (content) outputWriter.push(content);
        const reasoning = collectReasoningFromMessage(delta);
        if (reasoning) reasonWriter.push(reasoning);
        if (typeof choice.text === "string") outputWriter.push(choice.text);
        const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : Array.isArray((choice.message as Record<string, unknown> | undefined)?.tool_calls) ? (choice.message as Record<string, unknown>).tool_calls as unknown[] : [];
        for (const rawCall of calls) {
          if (!rawCall || typeof rawCall !== "object") continue;
          const call = rawCall as Record<string, unknown>;
          const index = Number(call.index ?? 0) || 0;
          const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
          const current = toolCalls.get(index) || { name: "", arguments: "" };
          if (typeof fn.name === "string" && fn.name) current.name = fn.name;
          if (typeof fn.arguments === "string" && current.arguments.length < LOG_PREVIEW_CHARS) {
            current.arguments += fn.arguments.slice(0, LOG_PREVIEW_CHARS - current.arguments.length);
          }
          toolCalls.set(index, current);
        }
      }

      const eventType = typeof data.type === "string" ? data.type : "";
      if (typeof data.delta === "string") {
        if (/reasoning|thinking/.test(eventType)) reasonWriter.push(data.delta);
        else outputWriter.push(data.delta);
      }
      if (data.delta && typeof data.delta === "object") {
        const delta = data.delta as Record<string, unknown>;
        if (typeof delta.text === "string") outputWriter.push(delta.text);
        if (typeof delta.thinking === "string") reasonWriter.push(delta.thinking);
        if (typeof delta.partial_json === "string") {
          const index = Number(data.index ?? 0) || 0;
          const current = toolCalls.get(index) || { name: "tool", arguments: "" };
          if (current.arguments.length < LOG_PREVIEW_CHARS) {
            current.arguments += delta.partial_json.slice(0, LOG_PREVIEW_CHARS - current.arguments.length);
          }
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
    if (pending.length > 256 * 1024) pending = pending.slice(-64 * 1024);
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
      if (tools) outputWriter.push(`\n${tools}`);
      return {
        output_text: outputWriter.preview || null,
        reasoning_text: reasonWriter.preview || null,
        output_file: outputWriter.close(),
        reasoning_file: reasonWriter.close(),
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
  const input = extractInputToDisk(params.body, params.path);
  const fromRes = extractFromResponse(params.responseBody);
  return {
    input_text: input.preview,
    input_file: input.file,
    stream: Boolean(params.stream),
    ...fromRes,
  };
}

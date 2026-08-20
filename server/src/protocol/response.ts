/**
 * Non-streaming response translation: source-dialect JSON → IrResponse →
 * target-dialect JSON.
 */
import {
  IrResponse,
  IrUsage,
  asString,
  fromIrUsage,
  isObject,
  mapFinishToAnthropic,
  mapFinishToOpenAI,
  mapFinishToResponses,
  toIrUsage,
} from "./ir";

function parseArguments(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return "{}";
  }
}

// ---------- from openai-completions ----------

export function fromChatCompletionsResponse(json: unknown): IrResponse | null {
  if (!isObject(json) || !Array.isArray(json.choices)) return null;
  const choice = json.choices[0];
  if (!isObject(choice)) return null;
  const message = isObject(choice.message) ? choice.message : isObject(choice.delta) ? choice.delta : {};
  let text = "";
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) {
    text = message.content
      .map((p) => (isObject(p) && typeof p.text === "string" ? p.text : typeof p === "string" ? p : ""))
      .join("");
  }
  let reasoning = "";
  if (typeof message.reasoning_content === "string") reasoning = message.reasoning_content;
  else if (typeof message.reasoning === "string") reasoning = message.reasoning;

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .map((call) => {
          if (!isObject(call)) return null;
          const fn = isObject(call.function) ? call.function : {};
          const name = asString(fn.name);
          if (!name) return null;
          return {
            id: asString(call.id) ?? `call_${name}`,
            name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : parseArguments(fn.arguments),
          };
        })
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
    : [];

  return {
    model: asString(json.model) ?? undefined,
    text,
    reasoning,
    toolCalls,
    finishReason: asString(choice.finish_reason) ?? (toolCalls.length ? "tool_calls" : "stop"),
    usage: toIrUsage(json.usage) ?? undefined,
  };
}

// ---------- from anthropic-messages ----------

export function fromAnthropicResponse(json: unknown): IrResponse | null {
  if (!isObject(json) || !Array.isArray(json.content)) return null;
  const texts: string[] = [];
  const reasons: string[] = [];
  const toolCalls: IrResponse["toolCalls"] = [];
  for (const block of json.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") reasons.push(block.thinking);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: asString(block.id) ?? `toolu_${toolCalls.length}`,
        name: asString(block.name) ?? "tool",
        arguments: parseArguments(block.input),
      });
    }
  }
  return {
    model: asString(json.model) ?? undefined,
    text: texts.join(""),
    reasoning: reasons.join(""),
    toolCalls,
    finishReason: asString(json.stop_reason) ?? "end_turn",
    usage: toIrUsage(json.usage) ?? undefined,
  };
}

// ---------- from openai-responses ----------

export function fromResponsesResponse(json: unknown): IrResponse | null {
  if (!isObject(json)) return null;
  const output = Array.isArray(json.output) ? json.output : [];
  const texts: string[] = [];
  const reasons: string[] = [];
  const toolCalls: IrResponse["toolCalls"] = [];
  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (isObject(block) && (block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    } else if (item.type === "reasoning") {
      if (Array.isArray(item.summary)) {
        for (const s of item.summary) {
          if (isObject(s) && typeof s.text === "string") reasons.push(s.text);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: asString(item.call_id) ?? asString(item.id) ?? `call_${toolCalls.length}`,
        name: asString(item.name) ?? "tool",
        arguments: typeof item.arguments === "string" ? item.arguments : parseArguments(item.arguments),
      });
    }
  }
  const status = asString(json.status) ?? "completed";
  const details = isObject(json.incomplete_details) ? asString(json.incomplete_details.reason) : null;
  return {
    model: asString(json.model) ?? undefined,
    text: texts.join(""),
    reasoning: reasons.join(""),
    toolCalls,
    finishReason:
      status === "incomplete" && details === "max_output_tokens"
        ? "length"
        : toolCalls.length
          ? "tool_calls"
          : status === "completed"
            ? "stop"
            : status,
    usage: toIrUsage(json.usage) ?? undefined,
  };
}

// ---------- emitters ----------

let idCounter = 0;
function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function toChatCompletionsResponse(ir: IrResponse, model?: string): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: ir.text || null,
  };
  if (ir.reasoning) message.reasoning_content = ir.reasoning;
  if (ir.toolCalls.length) {
    message.tool_calls = ir.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
    if (!ir.text) message.content = null;
  }
  return {
    id: nextId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? ir.model ?? "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishToOpenAI(ir.toolCalls.length ? "tool_calls" : ir.finishReason),
      },
    ],
    ...(ir.usage ? { usage: fromIrUsage(ir.usage, "openai") } : {}),
  };
}

export function toAnthropicResponse(ir: IrResponse, model?: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (ir.reasoning) content.push({ type: "thinking", thinking: ir.reasoning });
  if (ir.text) content.push({ type: "text", text: ir.text });
  for (const call of ir.toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.arguments);
    } catch {
      input = { raw: call.arguments };
    }
    content.push({ type: "tool_use", id: call.id, name: call.name, input });
  }
  const usage: IrUsage = ir.usage ?? { prompt: 0, completion: 0 };
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model: model ?? ir.model ?? "",
    content,
    stop_reason: mapFinishToAnthropic(ir.toolCalls.length ? "tool_calls" : ir.finishReason),
    usage: fromIrUsage(usage, "anthropic"),
  };
}

export function toResponsesResponse(ir: IrResponse, model?: string): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (ir.reasoning) {
    output.push({
      type: "reasoning",
      id: nextId("rs"),
      summary: [{ type: "summary_text", text: ir.reasoning }],
    });
  }
  if (ir.text) {
    output.push({
      type: "message",
      id: nextId("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: ir.text, annotations: [] }],
    });
  }
  for (const call of ir.toolCalls) {
    output.push({
      type: "function_call",
      id: nextId("fc"),
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  const { status, finishNote } = mapFinishToResponses(
    ir.toolCalls.length ? "tool_calls" : ir.finishReason,
  );
  return {
    id: nextId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: model ?? ir.model ?? "",
    status,
    ...(finishNote ? { incomplete_details: { reason: finishNote } } : {}),
    output,
    usage: fromIrUsage(ir.usage ?? { prompt: 0, completion: 0 }, "responses"),
  };
}

/**
 * Streaming translation. A source-dialect SSE frame parses into incremental
 * StreamEvents; a target-dialect emitter turns those events back into
 * well-formed SSE lines for the client, regenerating the whole event ceremony
 * (message_start / response.created / chunk envelopes) that strict clients
 * like Claude Code rely on.
 */
import {
  IrFinishReason,
  IrUsage,
  StreamEvent,
  asNumber,
  asString,
  fromIrUsage,
  isObject,
  mapFinishToAnthropic,
  mapFinishToOpenAI,
  toIrUsage,
} from "./ir";

type Frame = Record<string, unknown>;

// ---------- parsers: source frame → events ----------

export function parseChatCompletionsFrame(frame: Frame): StreamEvent[] {
  const events: StreamEvent[] = [];
  if (Array.isArray(frame.choices) && isObject(frame.choices[0])) {
    const choice = frame.choices[0];
    const delta = isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : null;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) {
        events.push({ type: "text", delta: delta.content });
      }
      const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning);
      if (reasoning) events.push({ type: "reasoning", delta: reasoning });
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!isObject(call)) continue;
          const index = asNumber(call.index) ?? 0;
          const fn = isObject(call.function) ? call.function : {};
          const id = asString(call.id);
          const name = asString(fn.name);
          if (id || name) {
            events.push({ type: "tool_start", index, id: id ?? `call_${index}`, name: name ?? "tool" });
          }
          if (typeof fn.arguments === "string" && fn.arguments) {
            events.push({ type: "tool_args", index, delta: fn.arguments });
          }
        }
      }
    }
    const finish = asString(choice.finish_reason);
    if (finish) events.push({ type: "finish", reason: finish });
  }
  const usage = toIrUsage(frame.usage);
  if (usage) events.push({ type: "usage", usage });
  return events;
}

export type AnthropicParserState = {
  usage: Partial<IrUsage>;
  sawFinish: boolean;
};

export function parseAnthropicFrame(frame: Frame, state: AnthropicParserState): StreamEvent[] {
  const events: StreamEvent[] = [];
  const type = asString(frame.type) ?? "";
  if (type === "message_start") {
    const message = isObject(frame.message) ? frame.message : {};
    events.push({ type: "start", model: asString(message.model) ?? undefined });
    const usage = toIrUsage(message.usage);
    if (usage) {
      state.usage.prompt = usage.prompt;
      if (usage.cached) state.usage.cached = usage.cached;
    }
  } else if (type === "content_block_start") {
    const index = asNumber(frame.index) ?? 0;
    const block = isObject(frame.content_block) ? frame.content_block : {};
    if (block.type === "tool_use") {
      events.push({
        type: "tool_start",
        index,
        id: asString(block.id) ?? `toolu_${index}`,
        name: asString(block.name) ?? "tool",
      });
    }
  } else if (type === "content_block_delta") {
    const index = asNumber(frame.index) ?? 0;
    const delta = isObject(frame.delta) ? frame.delta : {};
    const deltaType = asString(delta.type);
    if (deltaType === "text_delta" && typeof delta.text === "string" && delta.text) {
      events.push({ type: "text", delta: delta.text });
    } else if (deltaType === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      events.push({ type: "reasoning", delta: delta.thinking });
    } else if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
      events.push({ type: "tool_args", index, delta: delta.partial_json });
    }
  } else if (type === "message_delta") {
    const delta = isObject(frame.delta) ? frame.delta : {};
    const reason = asString(delta.stop_reason);
    const usage = toIrUsage(frame.usage);
    if (usage) {
      state.usage.completion = usage.completion;
      if (usage.reasoning) state.usage.reasoning = usage.reasoning;
    }
    if (reason) {
      state.sawFinish = true;
      events.push({ type: "finish", reason });
    }
  } else if (type === "message_stop") {
    const { prompt = 0, completion = 0, cached, reasoning } = state.usage;
    events.push({
      type: "usage",
      usage: { prompt, completion, cached, reasoning, total: prompt + completion },
    });
    events.push({ type: "done" });
  }
  return events;
}

export type ResponsesParserState = {
  /** output_index → tool ordinal, so argument deltas pair with their call. */
  toolIndexByOutput: Map<number, number>;
  toolCount: number;
};

export function parseResponsesFrame(frame: Frame, state: ResponsesParserState): StreamEvent[] {
  const events: StreamEvent[] = [];
  const type = asString(frame.type) ?? "";
  if (type === "response.created" || type === "response.in_progress") {
    const response = isObject(frame.response) ? frame.response : {};
    events.push({ type: "start", model: asString(response.model) ?? undefined });
  } else if (type === "response.output_text.delta") {
    if (typeof frame.delta === "string" && frame.delta) events.push({ type: "text", delta: frame.delta });
  } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    if (typeof frame.delta === "string" && frame.delta) events.push({ type: "reasoning", delta: frame.delta });
  } else if (type === "response.output_item.added") {
    const item = isObject(frame.item) ? frame.item : {};
    if (item.type === "function_call") {
      const outputIndex = asNumber(frame.output_index) ?? 0;
      const ordinal = state.toolCount++;
      state.toolIndexByOutput.set(outputIndex, ordinal);
      events.push({
        type: "tool_start",
        index: ordinal,
        id: asString(item.call_id) ?? asString(item.id) ?? `call_${ordinal}`,
        name: asString(item.name) ?? "tool",
      });
    }
  } else if (type === "response.function_call_arguments.delta") {
    const outputIndex = asNumber(frame.output_index) ?? 0;
    const ordinal = state.toolIndexByOutput.get(outputIndex) ?? outputIndex;
    if (typeof frame.delta === "string" && frame.delta) {
      events.push({ type: "tool_args", index: ordinal, delta: frame.delta });
    }
  } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const response = isObject(frame.response) ? frame.response : {};
    const status = asString(response.status) ?? (type === "response.incomplete" ? "incomplete" : "completed");
    const details = isObject(response.incomplete_details) ? asString(response.incomplete_details.reason) : null;
    const reason: IrFinishReason =
      status === "incomplete" && details === "max_output_tokens" ? "length" : status;
    events.push({ type: "finish", reason });
    const usage = toIrUsage(response.usage);
    if (usage) events.push({ type: "usage", usage });
    events.push({ type: "done" });
  }
  return events;
}

// ---------- emitters: events → target SSE lines ----------

export type Emitter = {
  push(event: StreamEvent): string[];
  /** Flush trailing frames when the source stream ends without a done. */
  end(): string[];
};

function sse(event: string | null, data: unknown): string {
  const payload = `data: ${typeof data === "string" ? data : JSON.stringify(data)}`;
  return event ? `event: ${event}\n${payload}` : payload;
}

function chunkId() {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createChatCompletionsEmitter(model: string, created = Math.floor(Date.now() / 1000)): Emitter {
  const id = chunkId();
  let finished = false;
  let doneSent = false;
  let pendingUsage: IrUsage | null = null;
  // source tool index → emitted ordinal (sources use wildly different indexes)
  const toolOrdinals = new Map<number, number>();

  const envelope = (delta: Frame, finishReason: string | null = null): Frame => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  });

  return {
    push(event) {
      switch (event.type) {
        case "start":
          return [];
        case "text":
          return [sse(null, envelope({ content: event.delta }))];
        case "reasoning":
          return [sse(null, envelope({ reasoning_content: event.delta }))];
        case "tool_start": {
          if (!toolOrdinals.has(event.index)) toolOrdinals.set(event.index, toolOrdinals.size);
          const ordinal = toolOrdinals.get(event.index)!;
          return [sse(null, envelope({
            tool_calls: [{
              index: ordinal,
              id: event.id,
              type: "function",
              function: { name: event.name, arguments: "" },
            }],
          }))];
        }
        case "tool_args": {
          const ordinal = toolOrdinals.get(event.index) ?? event.index;
          return [sse(null, envelope({
            tool_calls: [{ index: ordinal, function: { arguments: event.delta } }],
          }))];
        }
        case "usage":
          pendingUsage = event.usage;
          return [];
        case "finish": {
          finished = true;
          const lines = [sse(null, envelope({}, mapFinishToOpenAI(event.reason)))];
          if (pendingUsage) {
            lines.push(sse(null, {
              id, object: "chat.completion.chunk", created, model, choices: [],
              usage: fromIrUsage(pendingUsage, "openai"),
            }));
            pendingUsage = null;
          }
          return lines;
        }
        case "done": {
          const lines: string[] = [];
          if (pendingUsage) {
            lines.push(sse(null, {
              id, object: "chat.completion.chunk", created, model, choices: [],
              usage: fromIrUsage(pendingUsage, "openai"),
            }));
            pendingUsage = null;
          }
          if (!doneSent) {
            doneSent = true;
            lines.push("data: [DONE]");
          }
          return lines;
        }
      }
      return [];
    },
    end() {
      const lines: string[] = [];
      if (pendingUsage) {
        lines.push(sse(null, {
          id, object: "chat.completion.chunk", created, model, choices: [],
          usage: fromIrUsage(pendingUsage, "openai"),
        }));
      }
      if (finished && !doneSent) lines.push("data: [DONE]");
      return lines;
    },
  };
}

export function createAnthropicEmitter(model: string): Emitter {
  const id = `msg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let started = false;
  let blockIndex = -1;
  let blockKind: "text" | "thinking" | "tool" | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let pendingFinish: IrFinishReason | null = null;
  let stopSent = false;

  const startLines = (): string[] => {
    if (started) return [];
    started = true;
    return [sse("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: promptTokens, output_tokens: 0 },
      },
    }), sse("ping", { type: "ping" })];
  };

  const closeBlock = (lines: string[]) => {
    if (blockKind !== null) {
      lines.push(sse("content_block_stop", { type: "content_block_stop", index: blockIndex }));
      blockKind = null;
    }
  };

  const openBlock = (lines: string[], kind: "text" | "thinking" | "tool", tool?: { id: string; name: string }) => {
    closeBlock(lines);
    blockIndex += 1;
    blockKind = kind;
    const contentBlock =
      kind === "text"
        ? { type: "text", text: "" }
        : kind === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "tool_use", id: tool?.id ?? "", name: tool?.name ?? "", input: {} };
    lines.push(sse("content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: contentBlock,
    }));
  };

  const finishLines = (): string[] => {
    const lines: string[] = [];
    if (pendingFinish === null || stopSent) return lines;
    stopSent = true;
    closeBlock(lines);
    lines.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapFinishToAnthropic(pendingFinish), stop_sequence: null },
      usage: {
        output_tokens: completionTokens,
        ...(cachedTokens ? { cache_read_input_tokens: cachedTokens } : {}),
      },
    }));
    lines.push(sse("message_stop", { type: "message_stop" }));
    return lines;
  };

  return {
    push(event) {
      const lines = startLines();
      switch (event.type) {
        case "start":
          if (event.model) { /* client model name wins; emitter already bound */ }
          break;
        case "text":
          if (blockKind !== "text") openBlock(lines, "text");
          lines.push(sse("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: event.delta },
          }));
          break;
        case "reasoning":
          if (blockKind !== "thinking") openBlock(lines, "thinking");
          lines.push(sse("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "thinking_delta", thinking: event.delta },
          }));
          break;
        case "tool_start":
          openBlock(lines, "tool", { id: event.id, name: event.name });
          break;
        case "tool_args":
          if (blockKind === "tool") {
            lines.push(sse("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: event.delta },
            }));
          }
          break;
        case "usage":
          if (event.usage.prompt) promptTokens = event.usage.prompt;
          if (event.usage.completion) completionTokens = event.usage.completion;
          if (event.usage.cached) cachedTokens = event.usage.cached;
          break;
        case "finish":
          // Defer until done/usage so message_delta carries real output counts.
          pendingFinish = event.reason;
          break;
        case "done":
          lines.push(...finishLines());
          break;
      }
      return lines;
    },
    end() {
      if (pendingFinish === null && blockKind !== null) pendingFinish = "end_turn";
      return finishLines();
    },
  };
}

export function createResponsesEmitter(model: string): Emitter {
  const responseId = `resp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  let started = false;
  let outputIndex = -1;
  let openItem: { kind: "message" | "reasoning" | "function_call"; id: string; callId?: string; name?: string } | null = null;
  let textBuffer = "";
  let reasoningBuffer = "";
  let argsBuffer = "";
  const completedItems: Frame[] = [];
  let usage: IrUsage | null = null;
  let pendingFinish: IrFinishReason | null = null;
  let completedSent = false;

  const startLines = (): string[] => {
    if (started) return [];
    started = true;
    return [sse("response.created", {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        created_at: created,
        model,
        status: "in_progress",
        output: [],
      },
    })];
  };

  const closeItem = (lines: string[]) => {
    if (!openItem) return;
    if (openItem.kind === "message") {
      const item = {
        type: "message",
        id: openItem.id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: textBuffer, annotations: [] }],
      };
      completedItems.push(item);
      lines.push(sse("response.output_text.done", {
        type: "response.output_text.done",
        output_index: outputIndex,
        content_index: 0,
        text: textBuffer,
      }));
      lines.push(sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item }));
      textBuffer = "";
    } else if (openItem.kind === "reasoning") {
      const item = {
        type: "reasoning",
        id: openItem.id,
        summary: [{ type: "summary_text", text: reasoningBuffer }],
      };
      completedItems.push(item);
      lines.push(sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item }));
      reasoningBuffer = "";
    } else {
      const item = {
        type: "function_call",
        id: openItem.id,
        call_id: openItem.callId,
        name: openItem.name,
        arguments: argsBuffer,
        status: "completed",
      };
      completedItems.push(item);
      lines.push(sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        output_index: outputIndex,
        arguments: argsBuffer,
      }));
      lines.push(sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item }));
      argsBuffer = "";
    }
    openItem = null;
  };

  const completeLines = (): string[] => {
    if (completedSent || pendingFinish === null) return [];
    completedSent = true;
    const lines: string[] = [];
    closeItem(lines);
    const status = pendingFinish === "length" ? "incomplete" : "completed";
    lines.push(sse(status === "incomplete" ? "response.incomplete" : "response.completed", {
      type: status === "incomplete" ? "response.incomplete" : "response.completed",
      response: {
        id: responseId,
        object: "response",
        created_at: created,
        model,
        status,
        ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output: completedItems,
        ...(usage ? { usage: fromIrUsage(usage, "responses") } : {}),
      },
    }));
    return lines;
  };

  return {
    push(event) {
      const lines = startLines();
      switch (event.type) {
        case "start":
          break;
        case "text": {
          if (!openItem || openItem.kind !== "message") {
            closeItem(lines);
            outputIndex += 1;
            openItem = { kind: "message", id: `msg-${outputIndex}` };
            const item = { type: "message", id: openItem.id, role: "assistant", status: "in_progress", content: [] };
            lines.push(sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item }));
            lines.push(sse("response.content_part.added", {
              type: "response.content_part.added",
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }));
          }
          textBuffer += event.delta;
          lines.push(sse("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: outputIndex,
            content_index: 0,
            delta: event.delta,
          }));
          break;
        }
        case "reasoning": {
          if (!openItem || openItem.kind !== "reasoning") {
            closeItem(lines);
            outputIndex += 1;
            openItem = { kind: "reasoning", id: `rs-${outputIndex}` };
            const item = { type: "reasoning", id: openItem.id, summary: [] };
            lines.push(sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item }));
            lines.push(sse("response.reasoning_summary_part.added", {
              type: "response.reasoning_summary_part.added",
              output_index: outputIndex,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            }));
          }
          reasoningBuffer += event.delta;
          lines.push(sse("response.reasoning_summary_text.delta", {
            type: "response.reasoning_summary_text.delta",
            output_index: outputIndex,
            summary_index: 0,
            delta: event.delta,
          }));
          break;
        }
        case "tool_start": {
          closeItem(lines);
          outputIndex += 1;
          openItem = { kind: "function_call", id: `fc-${outputIndex}`, callId: event.id, name: event.name };
          const item = {
            type: "function_call",
            id: openItem.id,
            call_id: event.id,
            name: event.name,
            arguments: "",
            status: "in_progress",
          };
          lines.push(sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item }));
          break;
        }
        case "tool_args": {
          if (openItem?.kind === "function_call") {
            argsBuffer += event.delta;
            lines.push(sse("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              output_index: outputIndex,
              delta: event.delta,
            }));
          }
          break;
        }
        case "usage":
          usage = event.usage;
          break;
        case "finish":
          pendingFinish = event.reason;
          break;
        case "done":
          lines.push(...completeLines());
          break;
      }
      return lines;
    },
    end() {
      if (pendingFinish === null && (openItem || completedItems.length)) pendingFinish = "stop";
      return completeLines();
    },
  };
}

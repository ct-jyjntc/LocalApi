/**
 * Request-body translation between the three dialects, via IrRequest.
 * Only mainstream fields are carried over (messages, tools, sampling knobs,
 * max output, stream flag, reasoning effort); unknown extras are dropped so
 * strict upstreams never receive fields from a foreign dialect.
 */
import {
  IrContentPart,
  IrMessage,
  IrRequest,
  IrToolChoice,
  asNumber,
  asString,
  isObject,
} from "./ir";

// ---------- helpers ----------

function textPart(text: string): IrContentPart {
  return { type: "text", text };
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function toolArgumentsString(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((item) => (isObject(item) && typeof item.text === "string" ? item.text : null))
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content ?? "");
  }
}

// ---------- from openai-completions ----------

function ccContentToParts(content: unknown): IrContentPart[] {
  if (typeof content === "string") return content ? [textPart(content)] : [];
  if (!Array.isArray(content)) return [];
  const parts: IrContentPart[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) parts.push(textPart(item));
      continue;
    }
    if (!isObject(item)) continue;
    if ((item.type === "text" || item.type === "input_text" || item.type === "output_text") && typeof item.text === "string") {
      parts.push(textPart(item.text));
    } else if (item.type === "image_url" || item.type === "input_image") {
      const url = isObject(item.image_url)
        ? asString(item.image_url.url)
        : asString(item.image_url) ?? asString(item.image_url === undefined ? item.url : null);
      if (url) parts.push({ type: "image", url });
    }
  }
  return parts;
}

export function fromChatCompletionsRequest(body: unknown): IrRequest | null {
  if (!isObject(body) || !Array.isArray(body.messages)) return null;
  const messages: IrMessage[] = [];
  for (const raw of body.messages) {
    if (!isObject(raw)) continue;
    const role = asString(raw.role) ?? "user";
    const parts = ccContentToParts(raw.content);
    if (role === "assistant" && Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!isObject(call)) continue;
        const fn = isObject(call.function) ? call.function : {};
        parts.push({
          type: "tool_use",
          id: asString(call.id) ?? `call_${parts.length}`,
          name: asString(fn.name) ?? "tool",
          input: parseToolArguments(fn.arguments),
        });
      }
    }
    if (role === "tool") {
      parts.length = 0;
      parts.push({
        type: "tool_result",
        toolUseId: asString(raw.tool_call_id) ?? "",
        content: toolResultText(raw.content),
      });
    }
    const mappedRole =
      role === "developer" ? "system"
        : role === "system" || role === "user" || role === "assistant" || role === "tool"
          ? role
          : "user";
    messages.push({ role: mappedRole, parts });
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((t) => {
          if (!isObject(t)) return null;
          const fn = isObject(t.function) ? t.function : t;
          const name = asString(fn.name);
          if (!name) return null;
          return {
            name,
            description: asString(fn.description) ?? undefined,
            parameters: fn.parameters,
          };
        })
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
    : undefined;

  let toolChoice: IrToolChoice | undefined;
  if (typeof body.tool_choice === "string") {
    if (["auto", "none", "required"].includes(body.tool_choice)) {
      toolChoice = body.tool_choice as IrToolChoice;
    }
  } else if (isObject(body.tool_choice)) {
    const fn = isObject(body.tool_choice.function) ? body.tool_choice.function : {};
    const name = asString(fn.name);
    if (name) toolChoice = { name };
  }

  return {
    model: asString(body.model) ?? undefined,
    messages,
    tools,
    toolChoice,
    maxTokens: asNumber(body.max_tokens ?? body.max_completion_tokens),
    temperature: asNumber(body.temperature),
    topP: asNumber(body.top_p),
    stop: Array.isArray(body.stop)
      ? body.stop.filter((s): s is string => typeof s === "string")
      : asString(body.stop)
        ? [body.stop as string]
        : undefined,
    stream: body.stream === true,
    effort: asString(body.reasoning_effort) ?? undefined,
  };
}

// ---------- to openai-completions ----------

export function toChatCompletionsRequest(ir: IrRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const msg of ir.messages) {
    const text = msg.parts
      .filter((p): p is Extract<IrContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
    const toolUses = msg.parts.filter(
      (p): p is Extract<IrContentPart, { type: "tool_use" }> => p.type === "tool_use",
    );
    const toolResults = msg.parts.filter(
      (p): p is Extract<IrContentPart, { type: "tool_result" }> => p.type === "tool_result",
    );
    const images = msg.parts.filter(
      (p): p is Extract<IrContentPart, { type: "image" }> => p.type === "image",
    );

    if (toolResults.length) {
      for (const result of toolResults) {
        messages.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
      }
      continue;
    }

    let content: unknown = text || null;
    if (images.length) {
      const parts: Record<string, unknown>[] = [];
      if (text) parts.push({ type: "text", text });
      for (const image of images) {
        const url = image.url ?? (image.data ? `data:${image.mediaType ?? "image/png"};base64,${image.data}` : null);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
      content = parts;
    }

    const out: Record<string, unknown> = { role: msg.role, content };
    if (msg.role === "assistant" && toolUses.length) {
      out.tool_calls = toolUses.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: toolArgumentsString(call.input) },
      }));
      if (content === null) out.content = null;
    }
    messages.push(out);
  }

  return {
    ...(ir.model ? { model: ir.model } : {}),
    messages,
    ...(ir.tools?.length
      ? {
          tools: ir.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(ir.toolChoice !== undefined
      ? {
          tool_choice: typeof ir.toolChoice === "object"
            ? { type: "function", function: { name: ir.toolChoice.name } }
            : ir.toolChoice,
        }
      : {}),
    ...(ir.maxTokens !== undefined ? { max_tokens: ir.maxTokens } : {}),
    ...(ir.temperature !== undefined ? { temperature: ir.temperature } : {}),
    ...(ir.topP !== undefined ? { top_p: ir.topP } : {}),
    ...(ir.stop?.length ? { stop: ir.stop } : {}),
    ...(ir.stream ? { stream: true } : {}),
    ...(ir.effort ? { reasoning_effort: ir.effort } : {}),
  };
}

// ---------- from anthropic-messages ----------

export function fromAnthropicRequest(body: unknown): IrRequest | null {
  if (!isObject(body) || !Array.isArray(body.messages)) return null;
  const messages: IrMessage[] = [];

  // Top-level system prompt becomes a leading system IR message.
  if (typeof body.system === "string" && body.system) {
    messages.push({ role: "system", parts: [textPart(body.system)] });
  } else if (Array.isArray(body.system)) {
    const text = body.system
      .map((b) => (isObject(b) && typeof b.text === "string" ? b.text : ""))
      .join("");
    if (text) messages.push({ role: "system", parts: [textPart(text)] });
  }

  for (const raw of body.messages) {
    if (!isObject(raw)) continue;
    const role = asString(raw.role) === "assistant" ? "assistant" : "user";
    const parts: IrContentPart[] = [];
    if (typeof raw.content === "string") {
      if (raw.content) parts.push(textPart(raw.content));
    } else if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (!isObject(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(textPart(block.text));
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          parts.push({ type: "thinking", text: block.thinking });
        } else if (block.type === "image" && isObject(block.source)) {
          const source = block.source;
          if (source.type === "base64" && typeof source.data === "string") {
            parts.push({ type: "image", mediaType: asString(source.media_type) ?? undefined, data: source.data });
          } else if (source.type === "url" && typeof source.url === "string") {
            parts.push({ type: "image", url: source.url });
          }
        } else if (block.type === "tool_use") {
          parts.push({
            type: "tool_use",
            id: asString(block.id) ?? `toolu_${parts.length}`,
            name: asString(block.name) ?? "tool",
            input: block.input ?? {},
          });
        } else if (block.type === "tool_result") {
          parts.push({
            type: "tool_result",
            toolUseId: asString(block.tool_use_id) ?? "",
            content: toolResultText(block.content),
            isError: block.is_error === true,
          });
        }
      }
    }
    messages.push({ role, parts });
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((t) => {
          if (!isObject(t)) return null;
          const name = asString(t.name);
          if (!name) return null;
          return { name, description: asString(t.description) ?? undefined, parameters: t.input_schema };
        })
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
    : undefined;

  let toolChoice: IrToolChoice | undefined;
  if (isObject(body.tool_choice)) {
    const type = asString(body.tool_choice.type);
    if (type === "auto") toolChoice = "auto";
    else if (type === "any") toolChoice = "required";
    else if (type === "none") toolChoice = "none";
    else if (type === "tool") {
      const name = asString(body.tool_choice.name);
      if (name) toolChoice = { name };
    }
  }

  const effort = isObject(body.output_config)
    ? asString(body.output_config.effort) ?? asString(body.reasoning_effort)
    : asString(body.reasoning_effort);

  return {
    model: asString(body.model) ?? undefined,
    messages,
    tools,
    toolChoice,
    maxTokens: asNumber(body.max_tokens),
    temperature: asNumber(body.temperature),
    topP: asNumber(body.top_p),
    stop: Array.isArray(body.stop_sequences)
      ? body.stop_sequences.filter((s): s is string => typeof s === "string")
      : undefined,
    stream: body.stream === true,
    effort: effort ?? undefined,
  };
}

// ---------- to anthropic-messages ----------

export function toAnthropicRequest(ir: IrRequest): Record<string, unknown> {
  const systemTexts: string[] = [];
  const messages: Record<string, unknown>[] = [];
  let pendingToolResults: Extract<IrContentPart, { type: "tool_result" }>[] = [];

  const flushToolResults = () => {
    if (!pendingToolResults.length) return;
    messages.push({
      role: "user",
      content: pendingToolResults.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    });
    pendingToolResults = [];
  };

  for (const msg of ir.messages) {
    if (msg.role === "system") {
      for (const p of msg.parts) if (p.type === "text") systemTexts.push(p.text);
      continue;
    }
    if (msg.role === "tool") {
      for (const p of msg.parts) {
        if (p.type === "tool_result") pendingToolResults.push(p);
      }
      continue;
    }
    // tool_result parts may live inside a user message (fromAnthropic keeps
    // them inline); they must stay user-role blocks.
    const content: Record<string, unknown>[] = [];
    for (const p of msg.parts) {
      if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
      else if (p.type === "thinking" && msg.role === "assistant" && p.text) {
        content.push({ type: "thinking", thinking: p.text });
      } else if (p.type === "image") {
        if (p.data) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: p.mediaType ?? "image/png", data: p.data },
          });
        } else if (p.url) {
          content.push({ type: "image", source: { type: "url", url: p.url } });
        }
      } else if (p.type === "tool_use") {
        content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input ?? {} });
      } else if (p.type === "tool_result") {
        content.push({
          type: "tool_result",
          tool_use_id: p.toolUseId,
          content: p.content,
          ...(p.isError ? { is_error: true } : {}),
        });
      }
    }
    const role = msg.role === "assistant" ? "assistant" : "user";
    // Anthropic strictness: assistant messages may not carry tool_result,
    // and everything must be content blocks.
    if (role === "assistant") {
      flushToolResults();
      messages.push({ role, content: content.filter((c) => c.type !== "tool_result") });
    } else {
      messages.push({ role, content });
    }
  }
  flushToolResults();

  let toolChoice: Record<string, unknown> | undefined;
  if (ir.toolChoice === "auto") toolChoice = { type: "auto" };
  else if (ir.toolChoice === "none") toolChoice = { type: "none" };
  else if (ir.toolChoice === "required") toolChoice = { type: "any" };
  else if (typeof ir.toolChoice === "object") toolChoice = { type: "tool", name: ir.toolChoice.name };

  return {
    ...(ir.model ? { model: ir.model } : {}),
    // max_tokens is mandatory on /v1/messages.
    max_tokens: ir.maxTokens ?? 4096,
    messages,
    ...(systemTexts.length ? { system: systemTexts.join("\n") } : {}),
    ...(ir.tools?.length
      ? {
          tools: ir.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters ?? { type: "object", properties: {} },
          })),
        }
      : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(ir.temperature !== undefined ? { temperature: ir.temperature } : {}),
    ...(ir.topP !== undefined ? { top_p: ir.topP } : {}),
    ...(ir.stop?.length ? { stop_sequences: ir.stop } : {}),
    ...(ir.stream ? { stream: true } : {}),
    ...(ir.effort ? { output_config: { effort: ir.effort } } : {}),
  };
}

// ---------- from openai-responses ----------

export function fromResponsesRequest(body: unknown): IrRequest | null {
  if (!isObject(body)) return null;
  const messages: IrMessage[] = [];

  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", parts: [textPart(body.instructions)] });
  }

  const input = body.input;
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", parts: [textPart(input)] });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        if (item) messages.push({ role: "user", parts: [textPart(item)] });
        continue;
      }
      if (!isObject(item)) continue;
      const itemType = asString(item.type) ?? (typeof item.role === "string" ? "message" : "");
      if (itemType === "message") {
        const role = asString(item.role) ?? "user";
        const parts: IrContentPart[] = [];
        if (typeof item.content === "string") {
          if (item.content) parts.push(textPart(item.content));
        } else if (Array.isArray(item.content)) {
          for (const block of item.content) {
            if (!isObject(block)) continue;
            if (
              (block.type === "input_text" || block.type === "output_text" || block.type === "text") &&
              typeof block.text === "string"
            ) {
              parts.push(textPart(block.text));
            } else if (block.type === "input_image") {
              const url = asString(block.image_url);
              if (url) parts.push({ type: "image", url });
            }
          }
        }
        const mappedRole =
          role === "system" || role === "developer" ? "system" : role === "assistant" ? "assistant" : "user";
        messages.push({ role: mappedRole, parts });
      } else if (itemType === "function_call") {
        messages.push({
          role: "assistant",
          parts: [{
            type: "tool_use",
            id: asString(item.call_id) ?? asString(item.id) ?? `call_${messages.length}`,
            name: asString(item.name) ?? "tool",
            input: parseToolArguments(item.arguments),
          }],
        });
      } else if (itemType === "function_call_output") {
        messages.push({
          role: "tool",
          parts: [{
            type: "tool_result",
            toolUseId: asString(item.call_id) ?? "",
            content: toolResultText(item.output),
          }],
        });
      }
      // reasoning items in history are dropped: they carry no signal for the
      // next turn that the target dialect can use.
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .map((t) => {
          if (!isObject(t)) return null;
          const name = asString(t.name);
          if (!name) return null;
          return { name, description: asString(t.description) ?? undefined, parameters: t.parameters };
        })
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
    : undefined;

  let toolChoice: IrToolChoice | undefined;
  if (typeof body.tool_choice === "string") {
    if (["auto", "none", "required"].includes(body.tool_choice)) {
      toolChoice = body.tool_choice as IrToolChoice;
    }
  } else if (isObject(body.tool_choice)) {
    const name = asString(body.tool_choice.name);
    if (name) toolChoice = { name };
  }

  const effort = isObject(body.reasoning)
    ? asString(body.reasoning.effort) ?? asString(body.reasoning_effort)
    : asString(body.reasoning_effort);

  return {
    model: asString(body.model) ?? undefined,
    messages,
    tools,
    toolChoice,
    maxTokens: asNumber(body.max_output_tokens),
    temperature: asNumber(body.temperature),
    topP: asNumber(body.top_p),
    stream: body.stream === true,
    effort: effort ?? undefined,
  };
}

// ---------- to openai-responses ----------

export function toResponsesRequest(ir: IrRequest): Record<string, unknown> {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];

  for (const msg of ir.messages) {
    if (msg.role === "system") {
      for (const p of msg.parts) if (p.type === "text") instructions.push(p.text);
      continue;
    }
    if (msg.role === "tool") {
      for (const p of msg.parts) {
        if (p.type === "tool_result") {
          input.push({ type: "function_call_output", call_id: p.toolUseId, output: p.content });
        }
      }
      continue;
    }
    const content: Record<string, unknown>[] = [];
    for (const p of msg.parts) {
      if (p.type === "text" && p.text) {
        content.push({ type: msg.role === "assistant" ? "output_text" : "input_text", text: p.text });
      } else if (p.type === "image" && msg.role !== "assistant") {
        const url = p.url ?? (p.data ? `data:${p.mediaType ?? "image/png"};base64,${p.data}` : null);
        if (url) content.push({ type: "input_image", image_url: url });
      } else if (p.type === "tool_result") {
        input.push({ type: "function_call_output", call_id: p.toolUseId, output: p.content });
      }
    }
    if (content.length) {
      input.push({
        type: "message",
        role: msg.role === "assistant" ? "assistant" : "user",
        content,
      });
    }
    for (const p of msg.parts) {
      if (p.type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: p.id,
          name: p.name,
          arguments: toolArgumentsString(p.input),
        });
      }
    }
  }

  let toolChoice: unknown = ir.toolChoice;
  if (typeof ir.toolChoice === "object" && ir.toolChoice) {
    toolChoice = { type: "function", name: ir.toolChoice.name };
  }

  return {
    ...(ir.model ? { model: ir.model } : {}),
    input,
    ...(instructions.length ? { instructions: instructions.join("\n") } : {}),
    ...(ir.tools?.length
      ? {
          tools: ir.tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }
      : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(ir.maxTokens !== undefined ? { max_output_tokens: ir.maxTokens } : {}),
    ...(ir.temperature !== undefined ? { temperature: ir.temperature } : {}),
    ...(ir.topP !== undefined ? { top_p: ir.topP } : {}),
    ...(ir.stream ? { stream: true } : {}),
    ...(ir.effort ? { reasoning: { effort: ir.effort } } : {}),
  };
}

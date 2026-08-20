/**
 * Tiny mock upstream for local demo / cache verification.
 * Run: npx tsx src/mock-upstream.ts
 */
import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

let hitCount = 0;

app.get("/health", (_req, res) => res.json({ ok: true, service: "mock-upstream" }));

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "mock-echo", object: "model", owned_by: "mock" },
      { id: "gpt-4o-mini", object: "model", owned_by: "mock" },
    ],
  });
});

app.post("/v1/chat/completions", (req, res) => {
  hitCount += 1;
  const model = req.body?.model || "mock-echo";
  const messages = req.body?.messages || [];
  const last = messages[messages.length - 1];
  const content =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");

  // Artificial delay so cache hits feel faster
  setTimeout(() => {
    const wantsReasoning =
      /think|推理|reason/i.test(content) ||
      Boolean(req.body?.reasoning) ||
      req.body?.include_reasoning === true;

    res.json({
      id: `chatcmpl-mock-${hitCount}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `echo: ${content}`,
            ...(wantsReasoning
              ? {
                  reasoning_content: `step1: parse user text\nstep2: echo back\nstep3: done (${content.length} chars)`,
                }
              : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: (() => {
        const prompt_tokens = Math.max(8, Math.ceil(content.length / 4) + 6);
        const completion_tokens = Math.max(6, Math.ceil(content.length / 6) + 4);
        const reasoning_tokens = wantsReasoning ? 12 : 0;
        return {
          prompt_tokens,
          completion_tokens,
          reasoning_tokens,
          total_tokens: prompt_tokens + completion_tokens + reasoning_tokens,
          completion_tokens_details: wantsReasoning
            ? { reasoning_tokens: 12 }
            : undefined,
        };
      })(),
      upstream_hits: hitCount,
    });
  }, 120);
});

// OpenAI Responses API dialect — echoes effort back so mappings are visible.
app.post("/v1/responses", (req, res) => {
  hitCount += 1;
  const model = req.body?.model || "mock-echo";
  const input = req.body?.input;
  const text = Array.isArray(input)
    ? input.map((i: { content?: unknown }) => typeof i?.content === "string" ? i.content : JSON.stringify(i?.content ?? "")).join(" ")
    : String(input ?? "");
  const prompt = Math.max(8, Math.ceil(text.length / 4) + 6);
  const completion = Math.max(6, Math.ceil(text.length / 6) + 4);
  res.json({
    id: `resp-mock-${hitCount}`,
    object: "response",
    model,
    effort_seen: req.body?.reasoning?.effort ?? req.body?.reasoning_effort ?? null,
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: `echo: ${text}` }] },
    ],
    usage: {
      input_tokens: prompt,
      output_tokens: completion,
      total_tokens: prompt + completion,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    upstream_hits: hitCount,
  });
});

// Anthropic Messages API dialect — echoes output_config.effort back.
app.post("/v1/messages", (req, res) => {
  hitCount += 1;
  const model = req.body?.model || "mock-echo";
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const last = messages[messages.length - 1];
  const content =
    typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.map((p: { text?: string }) => p?.text ?? "").join("")
        : "";
  const prompt = Math.max(8, Math.ceil(content.length / 4) + 6);
  const completion = Math.max(6, Math.ceil(content.length / 6) + 4);
  res.json({
    id: `msg-mock-${hitCount}`,
    type: "message",
    role: "assistant",
    model,
    effort_seen: req.body?.output_config?.effort ?? req.body?.reasoning_effort ?? null,
    content: [{ type: "text", text: `echo: ${content}` }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: prompt,
      output_tokens: completion,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    upstream_hits: hitCount,
  });
});

app.post("/v1/embeddings", (req, res) => {  hitCount += 1;
  const input = req.body?.input ?? "";
  const text = Array.isArray(input) ? input.join(" ") : String(input);
  const dims = 8;
  const embedding = Array.from({ length: dims }, (_, i) =>
    ((text.length + i + hitCount) % 100) / 100,
  );
  res.json({
    object: "list",
    data: [{ object: "embedding", index: 0, embedding }],
    model: req.body?.model || "mock-echo",
    usage: { prompt_tokens: text.length, total_tokens: text.length },
    upstream_hits: hitCount,
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: { message: `Mock upstream has no route ${req.method} ${req.path}` },
  });
});

const port = Number(process.env.MOCK_PORT || 8790);
app.listen(port, () => {
  console.log(`Mock upstream on http://127.0.0.1:${port}`);
});

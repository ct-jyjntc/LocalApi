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

app.post("/v1/embeddings", (req, res) => {
  hitCount += 1;
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

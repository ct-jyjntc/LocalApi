import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";
import { TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useBrand } from "@/lib/branding";

type SectionId = "quickstart" | "auth" | "protocols" | "examples" | "errors" | "key-limits";

type DocGroup = {
  key: string;
  title: { zh: string; en: string };
  items: Array<{ id: SectionId; title: { zh: string; en: string } }>;
};

const DOC_TREE: DocGroup[] = [
  {
    key: "intro",
    title: { zh: "入门", en: "Getting started" },
    items: [
      { id: "quickstart", title: { zh: "快速开始", en: "Quick start" } },
      { id: "auth", title: { zh: "认证方式", en: "Authentication" } },
    ],
  },
  {
    key: "call",
    title: { zh: "调用", en: "Calling" },
    items: [
      { id: "protocols", title: { zh: "协议与端点", en: "Protocols" } },
      { id: "examples", title: { zh: "调用示例", en: "Examples" } },
    ],
  },
  {
    key: "reference",
    title: { zh: "参考", en: "Reference" },
    items: [
      { id: "errors", title: { zh: "错误码", en: "Error codes" } },
      { id: "key-limits", title: { zh: "Key 限额", en: "Key limits" } },
    ],
  },
];

const SECTION_IDS: SectionId[] = DOC_TREE.flatMap((group) => group.items.map((item) => item.id));

const buildCurlExample = (walletBase: string) => `curl ${walletBase}/chat/completions \\
  -H "Authorization: Bearer sk-your-api-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`;

const buildPythonExample = (walletBase: string) => `import requests

resp = requests.post(
    "${walletBase}/chat/completions",
    headers={"Authorization": "Bearer sk-your-api-key"},
    json={
        "model": "glm-5.3",
        "messages": [{"role": "user", "content": "Hello"}],
    },
)
print(resp.json())`;

const buildJsExample = (walletBase: string) => `const resp = await fetch("${walletBase}/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer sk-your-api-key",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "glm-5.3",
    messages: [{ role: "user", content: "Hello" }],
  }),
});
console.log(await resp.json());`;

const buildOpenaiSdkExample = (walletBase: string) => `from openai import OpenAI

client = OpenAI(
    base_url="${walletBase}",
    api_key="sk-your-api-key",
)

resp = client.chat.completions.create(
    model="glm-5.3",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp)`;

const buildAnthropicCurlExample = (walletBase: string) => `curl ${walletBase}/messages \\
  -H "x-api-key: sk-your-api-key" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3",
    "max_tokens": 1024,
    "messages": [{ "role": "user", "content": "Hello" }]
  }'`;

const buildResponsesCurlExample = (walletBase: string) => `curl ${walletBase}/responses \\
  -H "Authorization: Bearer sk-your-api-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3",
    "input": "Hello",
    "reasoning": { "effort": "high" }
  }'`;

const buildClaudeCodeExample = (siteBase: string) => `# Claude Code（Anthropic 协议）
export ANTHROPIC_BASE_URL=${siteBase}
export ANTHROPIC_AUTH_TOKEN=sk-your-api-key

# Coding 套餐改用：
# export ANTHROPIC_BASE_URL=${siteBase}/coding`;

export function UserDocsPage() {
  const { locale } = useI18n();
  const { branding } = useBrand();
  const zh = locale === "zh";
  const [activeId, setActiveId] = useState<SectionId>("quickstart");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DOC_TREE.map((group) => [group.key, true])),
  );

  const siteBase = useMemo(() => {
    const configured = (branding.data?.public_base_url || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    return typeof window === "undefined" ? "" : window.location.origin;
  }, [branding.data?.public_base_url]);
  const walletBase = `${siteBase}/v1`;
  const codingBase = `${siteBase}/coding/v1`;

  const anthropicCurlExample = useMemo(() => buildAnthropicCurlExample(walletBase), [walletBase]);
  const responsesCurlExample = useMemo(() => buildResponsesCurlExample(walletBase), [walletBase]);
  const claudeCodeExample = useMemo(() => buildClaudeCodeExample(siteBase), [siteBase]);
  const codeTabs = useMemo(
    () => [
      { key: "curl", label: "cURL", code: buildCurlExample(walletBase) },
      { key: "python", label: "Python", code: buildPythonExample(walletBase) },
      { key: "js", label: "JavaScript", code: buildJsExample(walletBase) },
      { key: "openai", label: "OpenAI SDK", code: buildOpenaiSdkExample(walletBase) },
    ],
    [walletBase],
  );

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id as SectionId);
        }
      },
      { rootMargin: "-15% 0px -70% 0px" },
    );
    for (const id of SECTION_IDS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: SectionId) => {
    setActiveId(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(zh ? "已复制" : "Copied");
  };

  const errors: Array<{ status: string; code: string; desc: string }> = [
    {
      status: "401",
      code: "—",
      desc: zh ? "Key 无效或已过期，请在「API Keys」页确认密钥状态。" : "Invalid or expired key. Check the key on the API Keys page.",
    },
    {
      status: "402",
      code: "insufficient_balance",
      desc: zh
        ? "钱包余额不足。若账号有 Coding 套餐却走了 /v1 也会报这个错 — 请改用 /coding/v1。"
        : "Wallet balance is insufficient. If your account has a Coding plan but calls /v1, switch the base URL to /coding/v1.",
    },
    {
      status: "402",
      code: "coding_plan_required",
      desc: zh ? "调用 /coding/v1 需要有效的 Coding 套餐。" : "Calling /coding/v1 requires an active Coding plan.",
    },
    {
      status: "403",
      code: "model_not_allowed",
      desc: zh ? "该模型不在你的可用范围内；错误消息里会列出可用模型。" : "The model is not allowed for your account; the error message lists the available models.",
    },
    {
      status: "400",
      code: "effort_not_supported",
      desc: zh
        ? "该模型不支持请求的思考档位；错误消息会列出支持的档位。"
        : "The model doesn't support the requested reasoning effort; the error message lists the supported levels.",
    },
    {
      status: "429",
      code: "rpm_limit_exceeded",
      desc: zh ? "触发每分钟请求数限制，请降低调用频率。" : "Requests-per-minute limit hit. Slow down your request rate.",
    },
    {
      status: "429",
      code: "tpm_limit_exceeded",
      desc: zh ? "触发每分钟 Token 数限制。" : "Tokens-per-minute limit hit.",
    },
    {
      status: "429",
      code: "concurrency_limit_exceeded",
      desc: zh ? "并发请求数超限，请等待在途请求完成。" : "Too many concurrent requests. Wait for in-flight requests to finish.",
    },
    {
      status: "429",
      code: "daily_quota_exceeded",
      desc: zh ? "该 Key 的日限额已用尽，按 UTC+8 自然日重置。" : "The key's daily quota is exhausted. It resets on the UTC+8 day boundary.",
    },
    {
      status: "429",
      code: "monthly_quota_exceeded",
      desc: zh ? "该 Key 的月限额已用尽，按 UTC+8 自然月重置。" : "The key's monthly quota is exhausted. It resets on the UTC+8 month boundary.",
    },
  ];

  return (
    <div className="grid w-full items-start gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
      {/* Left: doc tree */}
      <nav className="sticky top-5 hidden flex-col gap-3 sm:top-8 lg:flex" aria-label={zh ? "文档目录" : "Documentation tree"}>
        {DOC_TREE.map((group) => {
          const open = openGroups[group.key] !== false;
          return (
            <div key={group.key}>
              <button
                type="button"
                className="flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary/55"
                onClick={() => setOpenGroups((prev) => ({ ...prev, [group.key]: !open }))}
                aria-expanded={open}
              >
                {group.title[zh ? "zh" : "en"]}
                <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} strokeWidth={1.8} />
              </button>
              {open ? (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => scrollTo(item.id)}
                      aria-current={activeId === item.id ? "true" : undefined}
                      className={cn(
                        "flex h-7 items-center rounded-md px-2 pl-4 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/55 hover:text-foreground",
                        activeId === item.id && "bg-secondary/60 text-foreground",
                      )}
                    >
                      {item.title[zh ? "zh" : "en"]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>

      {/* Middle: content */}
      <div className="flex min-w-0 flex-col gap-6">
        <div>
          <h1 className="text-xl font-medium tracking-tight">{zh ? "使用文档" : "Documentation"}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {zh ? "接入方式、错误码与 Key 限额说明。" : "Integration guide, error codes and key limits."}
          </p>
        </div>

        <section id="quickstart" className="scroll-mt-6">
          <Card className="p-4 sm:p-5">
            <p className="text-sm font-medium">{zh ? "快速开始" : "Quick start"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {zh ? "根据计费方式选择 Base URL：" : "Pick the base URL by billing mode:"}
            </p>
            <div className="mt-3 overflow-hidden rounded-md border border-border/60">
              <div className={TABLE_HEAD_CLASS}><span className="min-w-0 flex-1">Base URL</span><span className="w-40 shrink-0">{zh ? "计费方式" : "Billing"}</span></div>
              <div className={TABLE_ROW_CLASS}><code className="min-w-0 flex-1 truncate font-mono text-[11px]">{walletBase}</code><span className="w-40 shrink-0 text-muted-foreground">{zh ? "钱包 / 余额" : "Wallet balance"}</span></div>
              <div className={TABLE_ROW_CLASS}><code className="min-w-0 flex-1 truncate font-mono text-[11px]">{codingBase}</code><span className="w-40 shrink-0 text-muted-foreground">{zh ? "Coding 套餐" : "Coding plan"}</span></div>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              {zh
                ? "支持 OpenAI Completions、OpenAI Responses、Anthropic Messages 三种协议与 GET /models。"
                : "OpenAI Completions, OpenAI Responses and Anthropic Messages are supported alongside GET /models."}
            </p>
          </Card>
        </section>

        <section id="auth" className="scroll-mt-6">
          <Card className="p-4 sm:p-5">
            <p className="text-sm font-medium">{zh ? "认证方式" : "Authentication"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {zh ? "所有请求都通过请求头认证：" : "Authenticate every request with the header:"}
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-md bg-secondary/55 p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{"Authorization: Bearer <your-api-key>"}</code>
              <Button variant="secondary" size="icon" onClick={() => copy("Authorization: Bearer <your-api-key>")} aria-label={zh ? "复制" : "Copy"}><Copy /></Button>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              {zh
                ? "Anthropic 风格客户端（如 Claude Code）也可以直接用 x-api-key: <your-api-key> 请求头，两者等价。"
                : "Anthropic-style clients (e.g. Claude Code) may send x-api-key: <your-api-key> instead; both are equivalent."}
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {zh ? "Key 在「API Keys」页创建。" : "Create keys on the API Keys page."}
            </p>
          </Card>
        </section>

        <section id="protocols" className="scroll-mt-6">
          <Card className="overflow-hidden">
            <div className="p-4 pb-3 sm:p-5 sm:pb-3">
              <p className="text-sm font-medium">{zh ? "协议与端点" : "Protocols & endpoints"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {zh
                  ? "三种主流协议任选其一接入。"
                  : "Pick any of the three mainstream dialects."}
              </p>
            </div>
            <div className={TABLE_HEAD_CLASS}><span className="w-44 shrink-0">{zh ? "端点" : "Endpoint"}</span><span className="min-w-0 flex-1">{zh ? "协议 / 说明" : "Dialect / notes"}</span></div>
            <div className={`${TABLE_ROW_CLASS} h-auto min-h-9 py-2`}>
              <code className="w-44 shrink-0 break-all font-mono text-[11px]">POST /chat/completions</code>
              <span className="min-w-0 flex-1 text-muted-foreground">
                {zh ? "OpenAI Completions。思考强度用顶层 reasoning_effort。" : "OpenAI Completions. Reasoning effort via top-level reasoning_effort."}
              </span>
            </div>
            <div className={`${TABLE_ROW_CLASS} h-auto min-h-9 py-2`}>
              <code className="w-44 shrink-0 break-all font-mono text-[11px]">POST /responses</code>
              <span className="min-w-0 flex-1 text-muted-foreground">
                {zh ? "OpenAI Responses。思考强度用 reasoning.effort，输出上限用 max_output_tokens。" : "OpenAI Responses. Reasoning effort via reasoning.effort; output cap is max_output_tokens."}
              </span>
            </div>
            <div className={`${TABLE_ROW_CLASS} h-auto min-h-9 py-2`}>
              <code className="w-44 shrink-0 break-all font-mono text-[11px]">POST /messages</code>
              <span className="min-w-0 flex-1 text-muted-foreground">
                {zh
                  ? "Anthropic Messages（Claude Code 等）。思考强度用 output_config.effort，max_tokens 必填；请带 anthropic-version 请求头。"
                  : "Anthropic Messages (Claude Code etc.). Reasoning effort via output_config.effort; max_tokens is required; send the anthropic-version header."}
              </span>
            </div>
            <div className="px-4 py-4 sm:px-5">
              <p className="text-xs font-medium text-foreground">{zh ? "Anthropic 协议示例" : "Anthropic example"}</p>
              <div className="mt-2"><CodeBlock tabs={[{ key: "anthropic", label: "cURL", code: anthropicCurlExample }]} onCopy={copy} zh={zh} /></div>
              <p className="mt-3 text-xs font-medium text-foreground">{zh ? "Responses 协议示例" : "Responses example"}</p>
              <div className="mt-2"><CodeBlock tabs={[{ key: "responses", label: "cURL", code: responsesCurlExample }]} onCopy={copy} zh={zh} /></div>
              <p className="mt-3 text-xs font-medium text-foreground">Claude Code</p>
              <div className="mt-2"><CodeBlock tabs={[{ key: "claude", label: "shell", code: claudeCodeExample }]} onCopy={copy} zh={zh} /></div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                {zh
                  ? "模型支持的思考档位见 GET /models 返回的 reasoning.effort；传入不支持的档位会返回 400（effort_not_supported）。"
                  : "See reasoning.effort in GET /models for the levels a model supports; an unsupported level fails with 400 effort_not_supported."}
              </p>
            </div>
          </Card>
        </section>

        <section id="examples" className="scroll-mt-6">
          <Card className="overflow-hidden">
            <div className="p-4 pb-3 sm:p-5 sm:pb-3">
              <p className="text-sm font-medium">{zh ? "调用示例" : "Examples"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {zh
                  ? "以下示例使用钱包 Base URL；使用 Coding 套餐时把 Base URL 换成 /coding/v1 即可。"
                  : "Examples use the wallet base URL; switch to /coding/v1 when calling with a Coding plan."}
              </p>
            </div>
            <div className="px-4 pb-4 sm:px-5 sm:pb-5">
              <CodeBlock tabs={codeTabs} onCopy={copy} zh={zh} />
            </div>
          </Card>
        </section>

        <section id="errors" className="scroll-mt-6">
          <Card className="overflow-hidden">
            <div className="p-4 pb-3 sm:p-5 sm:pb-3">
              <p className="text-sm font-medium">{zh ? "错误码" : "Error codes"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {zh ? "错误响应为 JSON，code 字段可程序化处理。" : "Errors are JSON responses; the code field is machine-readable."}
              </p>
            </div>
            <div className={TABLE_HEAD_CLASS}><span className="w-12 shrink-0">HTTP</span><span className="w-52 shrink-0">code</span><span className="min-w-0 flex-1">{zh ? "说明" : "Description"}</span></div>
            {errors.map((row, index) => (
              <div key={index} className={`${TABLE_ROW_CLASS} h-auto min-h-9 py-2`}>
                <span className="w-12 shrink-0 font-mono text-[11px] tabular-nums">{row.status}</span>
                <code className="w-52 shrink-0 break-all font-mono text-[11px]">{row.code}</code>
                <span className="min-w-0 flex-1 text-muted-foreground">{row.desc}</span>
              </div>
            ))}
          </Card>
        </section>

        <section id="key-limits" className="scroll-mt-6">
          <Card className="p-4 sm:p-5">
            <p className="text-sm font-medium">{zh ? "Key 限额" : "Key limits"}</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs text-muted-foreground">
              <li>{zh ? "在「API Keys」页可为每个 Key 单独设置限速（RPM）和日/月限额（按消费金额计算，单位 ¥）。" : "On the API Keys page you can set a rate limit (RPM) and daily/monthly quotas (charged by cost, in ¥) per key."}</li>
              <li>{zh ? "0 或留空表示不限；日/月限额分别按 UTC+8 自然日 / 自然月重置。" : "0 or empty means unlimited. Daily/monthly quotas reset on UTC+8 day/month boundaries."}</li>
              <li>{zh ? "Key 级限速只会比套餐 / 层级限速更严格，不会放宽。" : "Key-level limits can only be stricter than plan/tier limits, never looser."}</li>
            </ul>
          </Card>
        </section>
      </div>
    </div>
  );
}

function CodeBlock({ tabs, onCopy, zh }: { tabs: readonly { key: string; label: string; code: string }[]; onCopy: (text: string) => Promise<void>; zh: boolean }) {
  const [tab, setTab] = useState(tabs[0].key);
  const [copied, setCopied] = useState(false);
  const active = tabs.find((item) => item.key === tab) || tabs[0];

  const handleCopy = async () => {
    await onCopy(active.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-secondary/35 pl-2 pr-1.5">
        <div className="flex items-center gap-1" role="tablist" aria-label={zh ? "示例语言" : "Example language"}>
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                "-mb-px flex h-9 items-center border-b-2 px-2.5 text-[11px] transition-colors",
                tab === item.key
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3.5" strokeWidth={1.8} /> : <Copy className="size-3.5" strokeWidth={1.8} />}
          {zh ? "复制" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto bg-secondary/55 p-3 font-mono text-xs leading-relaxed">{active.code}</pre>
    </div>
  );
}

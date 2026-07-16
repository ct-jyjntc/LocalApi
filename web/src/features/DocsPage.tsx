import { PageHeader } from "@/components/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";

export function DocsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="space-y-6">
      <PageHeader
        title={zh ? "文档中心" : "Documentation"}
        description={zh ? "API 接入、余额计费与 Coding Plan 调用说明。" : "API access, wallet billing and Coding Plan usage."}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <DocCard title={zh ? "余额调用" : "Wallet billing"} badge="/v1">
          <p>{zh ? "默认接口使用账户余额结算，不受 Coding Plan 模型白名单限制；模型仍需由管理员配置价格。" : "Default endpoints charge the wallet and ignore the Coding Plan model allowlist. Models still need an active admin price."}</p>
          <Code>{`curl https://your-domain/v1/chat/completions \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}'`}</Code>
        </DocCard>

        <DocCard title="Coding Plan" badge="/coding/v1">
          <p>{zh ? "Coding Plan 请求必须使用 /coding 前缀，只能调用当前套餐允许的模型，并从套餐周期额度扣除。" : "Coding Plan requests must use the /coding prefix, are limited to plan models, and charge the plan quota."}</p>
          <Code>{`curl https://your-domain/coding/v1/chat/completions \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"coding-model","messages":[{"role":"user","content":"hi"}]}'`}</Code>
        </DocCard>
      </div>

      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-medium">{zh ? "兼容接口" : "Compatible endpoints"}</h2>
        <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {["/chat/completions", "/completions", "/embeddings", "/images/generations", "/audio/transcriptions", "/audio/speech"].map((path) => (
            <div key={path} className="rounded-md bg-secondary/45 px-3 py-2 font-mono text-[11px]">/v1{path}<br /><span className="text-muted-foreground">/coding/v1{path}</span></div>
          ))}
        </div>
      </Card>

      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-medium">{zh ? "常见状态码" : "Common status codes"}</h2>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <Status code="401" text={zh ? "API Key 无效或已过期" : "Invalid or expired API key"} />
          <Status code="402" text={zh ? "余额不足、套餐额度不足或未分配 Coding Plan" : "Insufficient wallet/plan quota or no Coding Plan"} />
          <Status code="403" text={zh ? "Coding Plan 不允许该模型" : "Model is not allowed by the Coding Plan"} />
          <Status code="429" text={zh ? "RPM、TPM 或并发限制" : "RPM, TPM or concurrency limit"} />
        </div>
      </Card>
    </div>
  );
}

function DocCard({ title, badge, children }: { title: string; badge: string; children: ReactNode }) {
  return <Card className="space-y-3 p-4 text-xs text-muted-foreground sm:p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium text-foreground">{title}</h2><Badge variant="secondary">{badge}</Badge></div>{children}</Card>;
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-md bg-secondary/55 p-3 font-mono text-[11px] leading-5 text-foreground">{children}</pre>;
}

function Status({ code, text }: { code: string; text: string }) {
  return <div className="flex items-center gap-3 rounded-md bg-secondary/45 px-3 py-2"><span className="w-9 shrink-0 font-mono font-medium tabular-nums">{code}</span><span className="text-muted-foreground">{text}</span></div>;
}
import type { ReactNode } from "react";

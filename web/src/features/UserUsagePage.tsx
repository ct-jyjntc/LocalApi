import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { userApi, type UsageRow } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserUsagePage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const query = useQuery({ queryKey: ["user", "usage"], queryFn: () => userApi.usage(500), refetchInterval: 5000 });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "用量与账单" : "Usage and billing"}
        description={zh ? "展开每条记录查看完整计费明细。" : "Expand a record to view the complete billing breakdown."}
      />
      <Card className="overflow-hidden">
        <div className={TABLE_HEAD_CLASS}>
          <span className="w-4 shrink-0" />
          <span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span>
          <span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输入" : "Input"}</span>
          <span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输出" : "Output"}</span>
          <span className="w-24 shrink-0 text-right">{zh ? "费用" : "Cost"}</span>
          <span className="w-20 shrink-0 text-right">{zh ? "状态" : "Status"}</span>
          <span className="hidden w-36 shrink-0 text-right lg:block">{zh ? "时间" : "Time"}</span>
        </div>
        {!query.data?.items.length ? (
          <EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无账单" : "No usage"}</EmptyState>
        ) : (
          <div className="divide-y divide-border/40">
            {query.data.items.map((row) => {
              const open = Boolean(expanded[row.id]);
              return (
                <div key={row.id} className="text-xs">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                    className="flex h-10 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-secondary/40"
                  >
                    {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
                    <span className="min-w-0 flex-1 truncate font-mono">{row.model}</span>
                    <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">{row.prompt_tokens.toLocaleString()}</span>
                    <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">{row.completion_tokens.toLocaleString()}</span>
                    <span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.cost_micros)}</span>
                    <span className="w-20 shrink-0 text-right"><Badge variant={row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"}>{row.status}</Badge></span>
                    <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:block">{shortTime(row.created_at)}</span>
                  </button>
                  {open ? <BillingDetails row={row} zh={zh} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function BillingDetails({ row, zh }: { row: UsageRow; zh: boolean }) {
  const tokenItems = [
    [zh ? "普通输入" : "Input", row.ordinary_input_tokens],
    [zh ? "缓存读取" : "Cache read", row.cache_read_tokens],
    [zh ? "缓存写入" : "Cache write", row.cache_write_tokens],
    [zh ? "输出" : "Output", row.completion_tokens],
  ] as const;
  const costItems = [
    [zh ? "输入费用" : "Input cost", row.input_cost_micros],
    [zh ? "缓存读取费用" : "Cache read cost", row.cache_read_cost_micros],
    [zh ? "缓存写入费用" : "Cache write cost", row.cache_write_cost_micros],
    [zh ? "输出费用" : "Output cost", row.output_cost_micros],
  ] as const;
  const priceItems = [
    [zh ? "输入单价" : "Input price", row.input_price_micros],
    [zh ? "输出单价" : "Output price", row.output_price_micros],
    [zh ? "缓存读取单价" : "Cache read price", row.cache_read_price_micros],
    [zh ? "缓存写入单价" : "Cache write price", row.cache_write_price_micros],
  ] as const;

  return (
    <div className="border-t border-border/40 bg-secondary/20 px-9 py-3 text-[11px]">
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-3">
        <DetailGroup title={zh ? "Token 明细" : "Token usage"}>
          {tokenItems.map(([label, value]) => <DetailLine key={label} label={label} value={Number(value).toLocaleString()} />)}
          <DetailLine label={zh ? "总 Token" : "Total tokens"} value={Number(row.total_tokens || 0).toLocaleString()} strong />
        </DetailGroup>
        <DetailGroup title={zh ? "价格（每百万 Token）" : "Prices (per 1M tokens)"}>
          {priceItems.map(([label, value]) => <DetailLine key={label} label={label} value={formatCredits(value)} />)}
        </DetailGroup>
        <DetailGroup title={zh ? "费用分解" : "Cost breakdown"}>
          <DetailLine label={zh ? "计费方式" : "Billing mode"} value={row.billing_mode === "coding" ? "Coding Plan" : (zh ? "余额" : "Wallet")} strong />
          {costItems.map(([label, value]) => <DetailLine key={label} label={label} value={formatCredits(value)} />)}
          <DetailLine label={zh ? "总费用" : "Total cost"} value={formatCredits(row.cost_micros)} strong />
          <DetailLine label={zh ? "套餐扣除" : "Plan charged"} value={formatCredits(row.plan_cost_micros)} />
          <DetailLine label={zh ? "钱包扣除" : "Wallet charged"} value={formatCredits(row.wallet_cost_micros)} />
        </DetailGroup>
      </div>
      {row.status_code ? <p className="mt-3 text-muted-foreground">HTTP {row.status_code}{row.error ? ` · ${row.error}` : ""}</p> : null}
    </div>
  );
}

function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return <div><p className="mb-1.5 font-medium text-foreground">{title}</p><div className="space-y-1">{children}</div></div>;
}

function DetailLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`flex items-center justify-between gap-3 ${strong ? "font-medium text-foreground" : "text-muted-foreground"}`}><span>{label}</span><span className="font-mono tabular-nums">{value}</span></div>;
}

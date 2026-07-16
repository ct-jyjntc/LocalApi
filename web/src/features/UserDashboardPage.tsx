import { useQuery } from "@tanstack/react-query";
import { userApi } from "@/lib/api";
import { EmptyState, MetricCard, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserDashboardPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const query = useQuery({ queryKey: ["user", "dashboard"], queryFn: userApi.dashboard, refetchInterval: 5000 });
  const data = query.data;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={data?.user.display_name || (zh ? "用户概览" : "Account overview")} description={zh ? "查看余额、套餐与 Token 消耗。" : "Track balance, plan and token usage."} />
      <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={zh ? "可用余额" : "Wallet balance"} value={formatCredits(data?.wallet?.balance_micros)} hint={zh ? `冻结 ${formatCredits(data?.wallet?.reserved_micros)}` : `Reserved ${formatCredits(data?.wallet?.reserved_micros)}`} />
        <MetricCard label={zh ? "套餐余额" : "Plan balance"} value={formatCredits(data?.subscription?.remaining_credits_micros)} hint={data?.subscription ? `${data.subscription.plan.name} · ${new Date(data.subscription.period_end).toLocaleDateString()}` : (zh ? "未分配套餐" : "No active plan")} />
        <MetricCard label={zh ? "累计消费" : "Usage cost"} value={formatCredits(data?.totals.cost_micros)} hint={zh ? `${data?.totals.requests || 0} 次请求` : `${data?.totals.requests || 0} requests`} />
        <MetricCard label={zh ? "输入 / 输出 Token" : "Input / output tokens"} value={`${(data?.totals.prompt_tokens || 0).toLocaleString()} / ${(data?.totals.completion_tokens || 0).toLocaleString()}`} hint={zh ? `缓存 ${(data?.totals.cached_tokens || 0).toLocaleString()}` : `Cached ${(data?.totals.cached_tokens || 0).toLocaleString()}`} />
      </section>
      <Card className="overflow-hidden">
        <div className={TABLE_HEAD_CLASS}><span className="min-w-0 flex-1">{zh ? "最近用量" : "Recent usage"}</span><span className="w-28 shrink-0 text-right">Token</span><span className="w-24 shrink-0 text-right">{zh ? "费用" : "Cost"}</span><span className="hidden w-36 shrink-0 text-right md:block">{zh ? "时间" : "Time"}</span></div>
        {!data?.recent.length ? <EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无用量" : "No usage"}</EmptyState> : data.recent.map((row) => (
          <div className={TABLE_ROW_CLASS} key={row.id}>
            <span className="min-w-0 flex-1 truncate font-mono">{row.model}</span>
            <span className="w-28 shrink-0 text-right font-mono tabular-nums">{row.total_tokens.toLocaleString()}</span>
            <span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.cost_micros)}</span>
            <span className="hidden w-36 shrink-0 items-center justify-end gap-2 text-right text-[11px] text-muted-foreground md:flex"><Badge variant={row.status === "completed" ? "success" : "destructive"}>{row.status}</Badge>{shortTime(row.created_at)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

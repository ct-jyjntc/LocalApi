import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function CommercialUsagePage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const usage = useQuery({ queryKey: ["commercial", "usage"], queryFn: () => api.commercial.usage(1000), refetchInterval: 5000 });
  const users = useQuery({ queryKey: ["commercial", "users"], queryFn: api.commercial.users.list });
  const names = new Map((users.data?.items ?? []).map((user) => [user.id, user.display_name]));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "计费用量" : "Billed usage"} description={zh ? "正式 usage 账本，包含价格快照后的套餐与钱包扣费。" : "Authoritative usage ledger with plan and wallet settlement."} />
      <Card className="overflow-hidden">
        {!usage.data?.items.length ? <EmptyState>{usage.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无计费用量" : "No billed usage"}</EmptyState> : <>
          <div className="divide-y divide-border/40 md:hidden">{usage.data.items.map((row) => (
            <div className="space-y-2 p-3 text-xs" key={row.id}>
              <div className="flex min-w-0 items-center justify-between gap-2"><p className="min-w-0 truncate font-medium">{names.get(row.user_id) || row.user_id.slice(0, 8)}</p><Badge variant={row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"}>{row.status}</Badge></div>
              <p className="break-all font-mono text-[11px]">{row.model}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-secondary/35 p-2.5 text-[11px]"><UsageStat label="Token" value={row.total_tokens.toLocaleString()} /><UsageStat label={zh ? "总费用" : "Cost"} value={formatCredits(row.cost_micros)} /><UsageStat label={zh ? "套餐" : "Plan"} value={formatCredits(row.plan_cost_micros)} /><UsageStat label={zh ? "余额" : "Wallet"} value={formatCredits(row.wallet_cost_micros)} /></div>
              <p className="text-right text-[11px] text-muted-foreground">{shortTime(row.created_at)}</p>
            </div>
          ))}</div>
          <div className="hidden md:block"><div className={TABLE_HEAD_CLASS}><span className="w-28 shrink-0">{zh ? "用户" : "User"}</span><span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span><span className="w-24 shrink-0 text-right">Token</span><span className="w-24 shrink-0 text-right">{zh ? "总费用" : "Cost"}</span><span className="w-24 shrink-0 text-right">{zh ? "套餐" : "Plan"}</span><span className="w-24 shrink-0 text-right">{zh ? "余额" : "Wallet"}</span><span className="w-20 shrink-0 text-right">{zh ? "状态" : "Status"}</span><span className="hidden w-36 shrink-0 text-right lg:block">{zh ? "时间" : "Time"}</span></div>{usage.data.items.map((row) => <div className={TABLE_ROW_CLASS} key={row.id}><span className="w-28 shrink-0 truncate">{names.get(row.user_id) || row.user_id.slice(0, 8)}</span><span className="min-w-0 flex-1 truncate font-mono">{row.model}</span><span className="w-24 shrink-0 text-right font-mono tabular-nums">{row.total_tokens.toLocaleString()}</span><span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.cost_micros)}</span><span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.plan_cost_micros)}</span><span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.wallet_cost_micros)}</span><span className="w-20 shrink-0 text-right"><Badge variant={row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"}>{row.status}</Badge></span><span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:block">{shortTime(row.created_at)}</span></div>)}</div>
        </>}
      </Card>
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className="mt-0.5 break-all font-mono tabular-nums text-foreground">{value}</p></div>;
}

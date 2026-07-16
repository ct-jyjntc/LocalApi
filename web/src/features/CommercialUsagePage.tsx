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
        <div className={TABLE_HEAD_CLASS}><span className="w-28 shrink-0">{zh ? "用户" : "User"}</span><span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span><span className="hidden w-24 shrink-0 text-right sm:block">Token</span><span className="w-24 shrink-0 text-right">{zh ? "总费用" : "Cost"}</span><span className="hidden w-24 shrink-0 text-right md:block">{zh ? "套餐" : "Plan"}</span><span className="hidden w-24 shrink-0 text-right md:block">{zh ? "余额" : "Wallet"}</span><span className="w-20 shrink-0 text-right">{zh ? "状态" : "Status"}</span><span className="hidden w-36 shrink-0 text-right lg:block">{zh ? "时间" : "Time"}</span></div>
        {!usage.data?.items.length ? <EmptyState>{usage.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无计费用量" : "No billed usage"}</EmptyState> : usage.data.items.map((row) => (
          <div className={TABLE_ROW_CLASS} key={row.id}>
            <span className="w-28 shrink-0 truncate">{names.get(row.user_id) || row.user_id.slice(0, 8)}</span>
            <span className="min-w-0 flex-1 truncate font-mono">{row.model}</span>
            <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">{row.total_tokens.toLocaleString()}</span>
            <span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.cost_micros)}</span>
            <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums md:block">{formatCredits(row.plan_cost_micros)}</span>
            <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums md:block">{formatCredits(row.wallet_cost_micros)}</span>
            <span className="w-20 shrink-0 text-right"><Badge variant={row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"}>{row.status}</Badge></span>
            <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:block">{shortTime(row.created_at)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

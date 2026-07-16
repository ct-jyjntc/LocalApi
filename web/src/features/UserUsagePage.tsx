import { useQuery } from "@tanstack/react-query";
import { userApi } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserUsagePage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const query = useQuery({ queryKey: ["user", "usage"], queryFn: () => userApi.usage(500), refetchInterval: 5000 });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "用量与账单" : "Usage and billing"} description={zh ? "每条请求使用当时的价格快照结算。" : "Each request is settled with its price snapshot."} />
      <Card className="overflow-hidden">
        <div className={TABLE_HEAD_CLASS}><span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span><span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输入" : "Input"}</span><span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输出" : "Output"}</span><span className="w-24 shrink-0 text-right">{zh ? "费用" : "Cost"}</span><span className="w-20 shrink-0 text-right">{zh ? "状态" : "Status"}</span><span className="hidden w-36 shrink-0 text-right lg:block">{zh ? "时间" : "Time"}</span></div>
        {!query.data?.items.length ? <EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无账单" : "No usage"}</EmptyState> : query.data.items.map((row) => (
          <div className={TABLE_ROW_CLASS} key={row.id}>
            <span className="min-w-0 flex-1 truncate font-mono">{row.model}</span>
            <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">{row.prompt_tokens.toLocaleString()}</span>
            <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">{row.completion_tokens.toLocaleString()}</span>
            <span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.cost_micros)}</span>
            <span className="w-20 shrink-0 text-right"><Badge variant={row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"}>{row.status}</Badge></span>
            <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:block">{shortTime(row.created_at)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

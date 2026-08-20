import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EmptyState, PageHeader, PaginationBar, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

const DEBOUNCE_MS = 350;

export function CommercialUsagePage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [page, setPage] = useState(0);
  const [userSearch, setUserSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [debouncedUser, setDebouncedUser] = useState("");
  const [debouncedModel, setDebouncedModel] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "pending" | "failed">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const pageSize = 50;

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedUser(userSearch.trim());
      setDebouncedModel(modelSearch.trim());
      setPage(0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [userSearch, modelSearch]);

  const usage = useQuery({
    queryKey: ["commercial", "usage", debouncedUser, debouncedModel, statusFilter, dateFrom, dateTo, page, pageSize],
    queryFn: () =>
      api.commercial.usage({
        limit: pageSize,
        offset: page * pageSize,
        user_query: debouncedUser || undefined,
        model: debouncedModel || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
      }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });

  const hasFilters = debouncedUser || debouncedModel || statusFilter !== "all" || dateFrom || dateTo;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "计费用量" : "Billed usage"}
        description={zh ? "正式 usage 账本，包含价格快照后的套餐与钱包扣费。" : "Authoritative usage ledger with plan and wallet settlement."}
      />
      <Card className="overflow-hidden">
        {/* Filter bar */}
        <div className="flex flex-col gap-3 border-b border-border/50 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
            <Input
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              placeholder={zh ? "搜索用户名 / 显示名" : "Search user"}
              className="sm:max-w-[200px]"
            />
            <Input
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
              placeholder={zh ? "搜索模型名称" : "Search model"}
              className="sm:max-w-[200px]"
            />
            <select
              className="h-8 rounded-md border border-input bg-secondary/55 px-2.5 text-xs"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as typeof statusFilter);
                setPage(0);
              }}
            >
              <option value="all">{zh ? "全部状态" : "All statuses"}</option>
              <option value="completed">completed</option>
              <option value="pending">pending</option>
              <option value="failed">failed</option>
            </select>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground shrink-0">{zh ? "开始" : "From"}</span>
              <Input
                type="date"
                value={dateFrom}
                onChange={(event) => { setDateFrom(event.target.value); setPage(0); }}
                className="h-8 w-[150px] text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground shrink-0">{zh ? "结束" : "To"}</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(event) => { setDateTo(event.target.value); setPage(0); }}
                className="h-8 w-[150px] text-xs"
              />
            </div>
            {hasFilters ? (
              <button
                type="button"
                className="h-8 rounded-md border border-border/50 bg-secondary/40 px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
                onClick={() => {
                  setUserSearch("");
                  setModelSearch("");
                  setStatusFilter("all");
                  setDateFrom("");
                  setDateTo("");
                  setPage(0);
                }}
              >
                {zh ? "清除筛选" : "Clear filters"}
              </button>
            ) : null}
            <p className="ml-auto text-[11px] text-muted-foreground">
              {usage.data ? `${usage.data.total.toLocaleString()} ${zh ? "条" : "records"}` : ""}
            </p>
          </div>
        </div>
        {!usage.data?.items.length ? (
          <EmptyState>{usage.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无计费用量" : "No billed usage"}</EmptyState>
        ) : (
          <>
            <div className="divide-y divide-border/40 md:hidden">
              {usage.data.items.map((row) => (
                <div className="space-y-2 p-3 text-xs" key={row.id}>
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <p className="min-w-0 truncate font-medium">
                      {row.user_label || row.username || row.display_name || row.user_id.slice(0, 8)}
                    </p>
                    <Badge
                      variant={
                        row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"
                      }
                    >
                      {row.status}
                    </Badge>
                  </div>
                  <p className="break-all font-mono text-[11px]">{row.model}</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-secondary/35 p-2.5 text-[11px]">
                    <UsageStat label="Token" value={row.total_tokens.toLocaleString()} />
                    <UsageStat label={zh ? "总费用" : "Cost"} value={formatCredits(row.cost_micros)} />
                    <UsageStat label={zh ? "套餐" : "Plan"} value={formatCredits(row.plan_cost_micros)} />
                    <UsageStat label={zh ? "余额" : "Wallet"} value={formatCredits(row.wallet_cost_micros)} />
                  </div>
                  <p className="text-right text-[11px] text-muted-foreground">{shortTime(row.created_at)}</p>
                </div>
              ))}
            </div>
            <div className="hidden md:block">
              <div className={TABLE_HEAD_CLASS}>
                <span className="w-28 shrink-0">{zh ? "用户" : "User"}</span>
                <span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span>
                <span className="w-24 shrink-0 text-right">Token</span>
                <span className="w-24 shrink-0 text-right">{zh ? "总费用" : "Cost"}</span>
                <span className="w-24 shrink-0 text-right">{zh ? "套餐" : "Plan"}</span>
                <span className="w-24 shrink-0 text-right">{zh ? "余额" : "Wallet"}</span>
                <span className="w-20 shrink-0 text-right">{zh ? "状态" : "Status"}</span>
                <span className="hidden w-36 shrink-0 text-right lg:block">{zh ? "时间" : "Time"}</span>
              </div>
              {usage.data.items.map((row) => (
                <div className={TABLE_ROW_CLASS} key={row.id}>
                  <span className="w-28 shrink-0 truncate">
                    {row.user_label || row.username || row.display_name || row.user_id.slice(0, 8)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{row.model}</span>
                  <span className="w-24 shrink-0 text-right font-mono tabular-nums">
                    {row.total_tokens.toLocaleString()}
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono tabular-nums">
                    {formatCredits(row.cost_micros)}
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono tabular-nums">
                    {formatCredits(row.plan_cost_micros)}
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono tabular-nums">
                    {formatCredits(row.wallet_cost_micros)}
                  </span>
                  <span className="w-20 shrink-0 text-right">
                    <Badge
                      variant={
                        row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"
                      }
                    >
                      {row.status}
                    </Badge>
                  </span>
                  <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:block">
                    {shortTime(row.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {usage.data ? (
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={usage.data.total}
            onPageChange={setPage}
            loading={usage.isFetching}
            zh={zh}
          />
        ) : null}
      </Card>
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-all font-mono tabular-nums text-foreground">{value}</p>
    </div>
  );
}

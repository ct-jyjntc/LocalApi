import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Ban, ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { userApi, type CommerceOrder, type UsageRow, type WalletLedgerRow } from "@/lib/api";
import { EmptyState, PageHeader, PaginationBar, TABLE_HEAD_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useAppDialog } from "@/components/app-dialog-context";

const PAGE_SIZE = 50;

/** 订单：充值与套餐订单记录（原"账单与订单"页的订单 Tab，已拆为独立页面）。 */
export function UserOrdersPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const [page, setPage] = useState(0);

  const orders = useQuery({
    queryKey: ["user", "commerce-orders", page, PAGE_SIZE],
    queryFn: () => userApi.commerce.orders({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });

  const refreshOrders = () => {
    qc.invalidateQueries({ queryKey: ["user", "commerce-orders"] });
    qc.invalidateQueries({ queryKey: ["user-payment-orders"] });
    qc.invalidateQueries({ queryKey: ["user", "commerce-ledger"] });
    qc.invalidateQueries({ queryKey: ["user", "me"] });
    qc.invalidateQueries({ queryKey: ["user", "dashboard"] });
  };
  const sync = useMutation({
    mutationFn: userApi.payments.sync,
    onSuccess: () => {
      toast.success(zh ? "订单状态已更新" : "Order updated");
      refreshOrders();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const cancel = useMutation({
    mutationFn: userApi.payments.cancel,
    onSuccess: () => {
      toast.success(zh ? "订单已取消" : "Order cancelled");
      refreshOrders();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: userApi.payments.remove,
    onSuccess: () => {
      toast.success(zh ? "订单已删除" : "Order deleted");
      refreshOrders();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const busy = sync.isPending || cancel.isPending || remove.isPending;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "订单" : "Orders"}
        description={zh ? "充值与套餐订单记录。" : "Top-up and plan order history."}
      />
      <OrdersPanel
        items={orders.data?.items || []}
        loading={orders.isLoading}
        busy={busy}
        zh={zh}
        page={page}
        pageSize={PAGE_SIZE}
        total={orders.data?.total ?? 0}
        fetching={orders.isFetching}
        onPageChange={setPage}
        onSync={(id) => sync.mutate(id)}
        onCancel={async (id) => {
          if (
            await dialogs.confirm({
              title: zh ? "取消充值订单" : "Cancel payment order",
              description: zh ? "订单取消后不能继续支付。" : "The order cannot be paid after cancellation.",
              confirmText: zh ? "取消订单" : "Cancel order",
              destructive: true,
            })
          )
            cancel.mutate(id);
        }}
        onDelete={async (id) => {
          if (
            await dialogs.confirm({
              title: zh ? "删除订单记录" : "Delete order record",
              description: zh ? "只会删除失败、过期或已取消的订单记录。" : "Only the failed order record will be removed.",
              confirmText: zh ? "删除" : "Delete",
              destructive: true,
            })
          )
            remove.mutate(id);
        }}
      />
    </div>
  );
}

/** 用量明细：逐次 API 调用记录。 */
export function UserUsageDetailPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(0);

  const usage = useQuery({
    queryKey: ["user", "usage", page, PAGE_SIZE],
    queryFn: () => userApi.usage({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "用量明细" : "Usage details"}
        description={zh ? "每一次 API 调用的模型、Token 与费用。" : "Per-request model, token and cost records."}
      />
      <UsagePanel
        items={usage.data?.items || []}
        loading={usage.isLoading}
        expanded={expanded}
        setExpanded={setExpanded}
        zh={zh}
        page={page}
        pageSize={PAGE_SIZE}
        total={usage.data?.total ?? 0}
        fetching={usage.isFetching}
        onPageChange={setPage}
      />
    </div>
  );
}

/** 钱包流水：余额变动记录。 */
export function UserWalletLedgerPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [page, setPage] = useState(0);

  const ledger = useQuery({
    queryKey: ["user", "commerce-ledger", page, PAGE_SIZE],
    queryFn: () => userApi.commerce.ledger({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: (prev) => prev,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "钱包流水" : "Wallet ledger"}
        description={zh ? "余额的每一笔变动记录。" : "Every wallet balance change."}
      />
      <LedgerPanel
        items={ledger.data?.items || []}
        loading={ledger.isLoading}
        zh={zh}
        page={page}
        pageSize={PAGE_SIZE}
        total={ledger.data?.total ?? 0}
        fetching={ledger.isFetching}
        onPageChange={setPage}
      />
    </div>
  );
}

function OrdersPanel({
  items,
  loading,
  busy,
  zh,
  page,
  pageSize,
  total,
  fetching,
  onPageChange,
  onSync,
  onCancel,
  onDelete,
}: {
  items: CommerceOrder[];
  loading: boolean;
  busy: boolean;
  zh: boolean;
  page: number;
  pageSize: number;
  total: number;
  fetching?: boolean;
  onPageChange: (page: number) => void;
  onSync: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden">
      {!items.length ? (
        <EmptyState>{loading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无订单" : "No orders"}</EmptyState>
      ) : (
        <div className="divide-y divide-border/40">
          {items.map((order) => (
            <div key={`${order.source}:${order.id}`} className="p-3 text-xs sm:px-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="secondary">{kindLabel(order.kind, zh)}</Badge>
                    <p className="min-w-0 truncate font-medium">{order.title}</p>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {order.order_no} · {shortTime(order.created_at)}
                  </p>
                </div>
                <StatusBadge status={order.status} zh={zh} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 sm:grid-cols-4">
                <OrderStat label={zh ? "账户变动" : "Settlement"} value={signedCredits(order.settlement_micros)} />
                <OrderStat
                  label={zh ? "外部支付" : "External"}
                  value={order.external_amount ? `${order.external_amount} ${order.external_asset}` : "—"}
                />
                <OrderStat
                  label={zh ? "折抵" : "Credit"}
                  value={order.discount_micros > 0 ? formatCredits(order.discount_micros) : "—"}
                />
                <OrderStat
                  label={zh ? "完成时间" : "Completed"}
                  value={order.completed_at ? shortTime(order.completed_at) : "—"}
                />
              </div>
              {order.error ? (
                <p className="mt-2 break-words rounded-md bg-destructive/8 px-3 py-2 text-[11px] text-destructive">
                  {order.error}
                </p>
              ) : null}
              {order.source === "payment" && Object.values(order.actions).some(Boolean) ? (
                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {order.actions.pay && order.pay_url ? (
                    <Button size="sm" variant="secondary" onClick={() => window.location.assign(order.pay_url!)}>
                      {zh ? "继续支付" : "Pay"}
                      <ArrowUpRight />
                    </Button>
                  ) : null}
                  {order.actions.sync ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSync(order.id)}>
                      <RefreshCw />
                      {zh ? "查单" : "Sync"}
                    </Button>
                  ) : null}
                  {order.actions.cancel ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(order.id)}>
                      <Ban />
                      {zh ? "取消" : "Cancel"}
                    </Button>
                  ) : null}
                  {order.actions.delete ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      onClick={() => onDelete(order.id)}
                    >
                      <Trash2 />
                      {zh ? "删除" : "Delete"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <PaginationBar page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} loading={fetching} zh={zh} />
    </Card>
  );
}

function UsagePanel({
  items,
  loading,
  expanded,
  setExpanded,
  zh,
  page,
  pageSize,
  total,
  fetching,
  onPageChange,
}: {
  items: UsageRow[];
  loading: boolean;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  zh: boolean;
  page: number;
  pageSize: number;
  total: number;
  fetching?: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className={TABLE_HEAD_CLASS}>
        <span className="w-4 shrink-0" />
        <span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span>
        <span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输入" : "Input"}</span>
        <span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输出" : "Output"}</span>
        <span className="w-20 shrink-0 text-right">{zh ? "费用" : "Cost"}</span>
        <span className="w-16 shrink-0 text-right">{zh ? "状态" : "Status"}</span>
        <span className="hidden w-36 shrink-0 text-right lg:block">{zh ? "时间" : "Time"}</span>
      </div>
      {!items.length ? (
        <EmptyState>{loading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无用量" : "No usage"}</EmptyState>
      ) : (
        <div className="divide-y divide-border/40">
          {items.map((row) => {
            const open = Boolean(expanded[row.id]);
            return (
              <div key={row.id} className="text-xs">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                  className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-secondary/40"
                >
                  {open ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">{row.model}</span>
                  <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">
                    {row.prompt_tokens.toLocaleString()}
                  </span>
                  <span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">
                    {row.completion_tokens.toLocaleString()}
                  </span>
                  <span className="w-20 shrink-0 text-right font-mono tabular-nums">
                    {formatCredits(row.cost_micros)}
                  </span>
                  <span className="flex w-16 shrink-0 justify-end">
                    <Badge
                      variant={
                        row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"
                      }
                    >
                      {statusLabel(row.status, zh)}
                    </Badge>
                  </span>
                  <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:block">
                    {shortTime(row.created_at)}
                  </span>
                </button>
                {open ? <BillingDetails row={row} zh={zh} /> : null}
              </div>
            );
          })}
        </div>
      )}
      <PaginationBar page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} loading={fetching} zh={zh} />
    </Card>
  );
}

function LedgerPanel({
  items,
  loading,
  zh,
  page,
  pageSize,
  total,
  fetching,
  onPageChange,
}: {
  items: WalletLedgerRow[];
  loading: boolean;
  zh: boolean;
  page: number;
  pageSize: number;
  total: number;
  fetching?: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <Card className="overflow-hidden">
      {!items.length ? (
        <EmptyState>{loading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无钱包流水" : "No wallet activity"}</EmptyState>
      ) : (
        <div className="divide-y divide-border/40">
          {items.map((row) => (
            <div
              key={row.id}
              className="grid gap-2 px-3 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_120px_120px_150px] sm:items-center sm:px-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{row.description || ledgerType(row.type, zh)}</p>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{ledgerType(row.type, zh)}</p>
              </div>
              <OrderStat label={zh ? "金额" : "Amount"} value={signedCredits(row.amount_micros)} />
              <OrderStat label={zh ? "变动后余额" : "Balance"} value={formatCredits(row.balance_after_micros)} />
              <p className="font-mono text-[10px] text-muted-foreground sm:text-right">{shortTime(row.created_at)}</p>
            </div>
          ))}
        </div>
      )}
      <PaginationBar page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} loading={fetching} zh={zh} />
    </Card>
  );
}

function BillingDetails({ row, zh }: { row: UsageRow; zh: boolean }) {
  return (
    <div className="space-y-2 border-t border-border/30 bg-secondary/20 px-3 py-3 text-[11px]">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <OrderStat label={zh ? "套餐扣费" : "Plan cost"} value={formatCredits(row.plan_cost_micros)} />
        <OrderStat label={zh ? "余额扣费" : "Wallet cost"} value={formatCredits(row.wallet_cost_micros)} />
        <OrderStat label={zh ? "缓存读" : "Cache read"} value={String(row.cached_tokens || 0)} />
        <OrderStat label={zh ? "推理" : "Reasoning"} value={String(row.reasoning_tokens || 0)} />
      </div>
      {row.error ? <p className="text-destructive">{row.error}</p> : null}
    </div>
  );
}

function OrderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-all font-mono tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function StatusBadge({ status, zh }: { status: string; zh: boolean }) {
  const map: Record<string, string> = zh
    ? {
        pending: "待支付",
        paid: "已支付",
        credited: "已入账",
        completed: "已完成",
        failed: "失败",
        expired: "已过期",
        cancelled: "已取消",
        refunding: "退款中",
        refunded: "已退款",
      }
    : {};
  const variant =
    status === "completed" || status === "credited"
      ? "success"
      : status === "pending" || status === "paid" || status === "refunding"
        ? "secondary"
        : "destructive";
  return <Badge variant={variant as "success" | "secondary" | "destructive"}>{map[status] || status}</Badge>;
}

function kindLabel(kind: string, zh: boolean) {
  if (kind === "wallet_topup") return zh ? "余额充值" : "Top-up";
  if (kind.startsWith("plan_")) return zh ? "套餐订单" : "Plan";
  return kind;
}

function statusLabel(status: string, zh: boolean) {
  if (!zh) return status;
  if (status === "completed") return "完成";
  if (status === "pending") return "进行中";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "取消";
  return status;
}

function ledgerType(type: string, zh: boolean) {
  if (!zh) return type;
  const map: Record<string, string> = {
    payment_topup: "充值入账",
    payment_refund: "充值退款",
    usage: "API 扣费",
    points_exchange: "积分兑换",
    adjustment: "调账",
    plan_purchase: "购买套餐",
    plan_upgrade: "升级套餐",
    plan_renewal: "续费套餐",
  };
  return map[type] || type;
}

function signedCredits(value: number) {
  const text = formatCredits(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

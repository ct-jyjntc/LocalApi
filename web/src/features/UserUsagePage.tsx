import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Ban, ChartNoAxesCombined, ChevronDown, ChevronRight, ReceiptText, RefreshCw, Trash2, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { userApi, type CommerceOrder, type UsageRow, type WalletLedgerRow } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppDialog } from "@/components/app-dialog-context";

type BillingTab = "orders" | "usage" | "ledger";

export function UserUsagePage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const [tab, setTab] = useState<BillingTab>("orders");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const orders = useQuery({ queryKey: ["user", "commerce-orders"], queryFn: () => userApi.commerce.orders(500), refetchInterval: 5_000 });
  const usage = useQuery({ queryKey: ["user", "usage"], queryFn: () => userApi.usage(500), refetchInterval: 5_000 });
  const ledger = useQuery({ queryKey: ["user", "commerce-ledger"], queryFn: () => userApi.commerce.ledger(500) });
  const refreshOrders = () => {
    qc.invalidateQueries({ queryKey: ["user", "commerce-orders"] });
    qc.invalidateQueries({ queryKey: ["user-payment-orders"] });
    qc.invalidateQueries({ queryKey: ["user", "commerce-ledger"] });
    qc.invalidateQueries({ queryKey: ["user-me"] });
    qc.invalidateQueries({ queryKey: ["user-dashboard"] });
  };
  const sync = useMutation({ mutationFn: userApi.payments.sync, onSuccess: () => { toast.success(zh ? "订单状态已更新" : "Order updated"); refreshOrders(); }, onError: (error: Error) => toast.error(error.message) });
  const cancel = useMutation({ mutationFn: userApi.payments.cancel, onSuccess: () => { toast.success(zh ? "订单已取消" : "Order cancelled"); refreshOrders(); }, onError: (error: Error) => toast.error(error.message) });
  const remove = useMutation({ mutationFn: userApi.payments.remove, onSuccess: () => { toast.success(zh ? "订单已删除" : "Order deleted"); refreshOrders(); }, onError: (error: Error) => toast.error(error.message) });
  const busy = sync.isPending || cancel.isPending || remove.isPending;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "账单与订单" : "Billing and orders"} description={zh ? "订单、API 用量和钱包资金流水统一在这里查看。" : "Review orders, API usage and wallet ledger in one place."} />
      <div className="flex w-full gap-1 overflow-x-auto rounded-md bg-secondary/45 p-1 sm:w-fit">
        <TabButton active={tab === "orders"} onClick={() => setTab("orders")} icon={ReceiptText}>{zh ? "订单" : "Orders"}</TabButton>
        <TabButton active={tab === "usage"} onClick={() => setTab("usage")} icon={ChartNoAxesCombined}>{zh ? "用量明细" : "Usage"}</TabButton>
        <TabButton active={tab === "ledger"} onClick={() => setTab("ledger")} icon={WalletCards}>{zh ? "钱包流水" : "Wallet"}</TabButton>
      </div>

      {tab === "orders" ? <OrdersPanel items={orders.data?.items || []} loading={orders.isLoading} busy={busy} zh={zh} onSync={(id) => sync.mutate(id)} onCancel={async (id) => { if (await dialogs.confirm({ title: zh ? "取消充值订单" : "Cancel payment order", description: zh ? "订单取消后不能继续支付。" : "The order cannot be paid after cancellation.", confirmText: zh ? "取消订单" : "Cancel order", destructive: true })) cancel.mutate(id); }} onDelete={async (id) => { if (await dialogs.confirm({ title: zh ? "删除订单记录" : "Delete order record", description: zh ? "只会删除失败、过期或已取消的订单记录。" : "Only the failed order record will be removed.", confirmText: zh ? "删除" : "Delete", destructive: true })) remove.mutate(id); }} /> : null}
      {tab === "usage" ? <UsagePanel items={usage.data?.items || []} loading={usage.isLoading} expanded={expanded} setExpanded={setExpanded} zh={zh} /> : null}
      {tab === "ledger" ? <LedgerPanel items={ledger.data?.items || []} loading={ledger.isLoading} zh={zh} /> : null}
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof ReceiptText; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={cn("flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-xs text-muted-foreground transition-colors", active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground")}><Icon className="size-3.5" strokeWidth={1.8} />{children}</button>;
}

function OrdersPanel({ items, loading, busy, zh, onSync, onCancel, onDelete }: { items: CommerceOrder[]; loading: boolean; busy: boolean; zh: boolean; onSync: (id: string) => void; onCancel: (id: string) => void; onDelete: (id: string) => void }) {
  return <Card className="overflow-hidden">{!items.length ? <EmptyState>{loading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无订单" : "No orders")}</EmptyState> : <div className="divide-y divide-border/45">{items.map((order) => <div key={`${order.source}:${order.id}`} className="p-3 text-xs sm:px-4"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><Badge variant="secondary">{kindLabel(order.kind, zh)}</Badge><p className="min-w-0 truncate font-medium">{order.title}</p></div><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{order.order_no} · {shortTime(order.created_at)}</p></div><StatusBadge status={order.status} zh={zh} /></div><div className="mt-2 grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 sm:grid-cols-4"><OrderStat label={zh ? "账户变动" : "Settlement"} value={signedCredits(order.settlement_micros)} /><OrderStat label={zh ? "外部支付" : "External"} value={order.external_amount ? `${order.external_amount} ${order.external_asset}` : "—"} /><OrderStat label={zh ? "折抵" : "Credit"} value={order.discount_micros > 0 ? formatCredits(order.discount_micros) : "—"} /><OrderStat label={zh ? "完成时间" : "Completed"} value={order.completed_at ? shortTime(order.completed_at) : "—"} /></div>{order.error ? <p className="mt-2 break-words rounded-md bg-destructive/8 px-3 py-2 text-[11px] text-destructive">{order.error}</p> : null}{order.source === "payment" && Object.values(order.actions).some(Boolean) ? <div className="mt-2 flex flex-wrap justify-end gap-1.5">{order.actions.pay && order.pay_url ? <Button size="sm" variant="secondary" onClick={() => window.location.assign(order.pay_url!)}>{zh ? "继续支付" : "Pay"}<ArrowUpRight /></Button> : null}{order.actions.sync ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSync(order.id)}><RefreshCw />{zh ? "查单" : "Sync"}</Button> : null}{order.actions.cancel ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(order.id)}><Ban />{zh ? "取消" : "Cancel"}</Button> : null}{order.actions.delete ? <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => onDelete(order.id)}><Trash2 />{zh ? "删除" : "Delete"}</Button> : null}</div> : null}</div>)}</div>}</Card>;
}

function UsagePanel({ items, loading, expanded, setExpanded, zh }: { items: UsageRow[]; loading: boolean; expanded: Record<string, boolean>; setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; zh: boolean }) {
  return <Card className="overflow-hidden"><div className={TABLE_HEAD_CLASS}><span className="w-4 shrink-0" /><span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span><span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输入" : "Input"}</span><span className="hidden w-24 shrink-0 text-right sm:block">{zh ? "输出" : "Output"}</span><span className="w-20 shrink-0 text-right">{zh ? "费用" : "Cost"}</span><span className="w-16 shrink-0 text-right">{zh ? "状态" : "Status"}</span><span className="hidden w-36 shrink-0 text-right lg:block">{zh ? "时间" : "Time"}</span></div>{!items.length ? <EmptyState>{loading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无用量" : "No usage")}</EmptyState> : <div className="divide-y divide-border/40">{items.map((row) => { const open = Boolean(expanded[row.id]); return <div key={row.id} className="text-xs"><button type="button" aria-expanded={open} onClick={() => setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))} className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-secondary/40">{open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1 truncate font-mono">{row.model}</span><span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">{row.prompt_tokens.toLocaleString()}</span><span className="hidden w-24 shrink-0 text-right font-mono tabular-nums sm:block">{row.completion_tokens.toLocaleString()}</span><span className="w-20 shrink-0 text-right font-mono tabular-nums">{formatCredits(row.cost_micros)}</span><span className="flex w-16 shrink-0 justify-end"><Badge variant={row.status === "completed" ? "success" : row.status === "pending" ? "secondary" : "destructive"}>{statusLabel(row.status, zh)}</Badge></span><span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:block">{shortTime(row.created_at)}</span></button>{open ? <BillingDetails row={row} zh={zh} /> : null}</div>; })}</div>}</Card>;
}

function LedgerPanel({ items, loading, zh }: { items: WalletLedgerRow[]; loading: boolean; zh: boolean }) {
  return <Card className="overflow-hidden">{!items.length ? <EmptyState>{loading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无钱包流水" : "No wallet activity")}</EmptyState> : <div className="divide-y divide-border/45">{items.map((row) => <div key={row.id} className="grid gap-2 px-3 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_120px_120px_150px] sm:items-center sm:px-4"><div className="min-w-0"><p className="truncate font-medium">{row.description || ledgerType(row.type, zh)}</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground">{ledgerType(row.type, zh)}</p></div><OrderStat label={zh ? "金额" : "Amount"} value={signedCredits(row.amount_micros)} /><OrderStat label={zh ? "变动后余额" : "Balance"} value={formatCredits(row.balance_after_micros)} /><p className="font-mono text-[10px] text-muted-foreground sm:text-right">{shortTime(row.created_at)}</p></div>)}</div>}</Card>;
}

function BillingDetails({ row, zh }: { row: UsageRow; zh: boolean }) {
  const tokenItems = [[zh ? "普通输入" : "Input", row.ordinary_input_tokens], [zh ? "缓存读取" : "Cache read", row.cache_read_tokens], [zh ? "缓存写入" : "Cache write", row.cache_write_tokens], [zh ? "输出" : "Output", row.completion_tokens]] as const;
  const costItems = [[zh ? "输入费用" : "Input cost", row.input_cost_micros], [zh ? "缓存读取费用" : "Cache read cost", row.cache_read_cost_micros], [zh ? "缓存写入费用" : "Cache write cost", row.cache_write_cost_micros], [zh ? "输出费用" : "Output cost", row.output_cost_micros]] as const;
  const priceItems = [[zh ? "输入单价" : "Input price", row.input_price_micros], [zh ? "输出单价" : "Output price", row.output_price_micros], [zh ? "缓存读取单价" : "Cache read price", row.cache_read_price_micros], [zh ? "缓存写入单价" : "Cache write price", row.cache_write_price_micros]] as const;
  return <div className="border-t border-border/40 bg-secondary/15 p-3 text-[11px] sm:p-4"><div className="mb-3 flex flex-wrap items-center gap-2 text-muted-foreground"><Badge variant={row.billing_mode === "coding" ? "default" : "secondary"}>{row.billing_mode === "coding" ? "Coding Plan" : (zh ? "余额计费" : "Wallet")}</Badge><span>{shortTime(row.created_at)}</span>{row.status_code ? <span className={row.status_code >= 400 ? "font-mono text-destructive" : "font-mono"}>HTTP {row.status_code}</span> : null}<span className="ml-auto font-mono tabular-nums text-foreground">{zh ? "总费用" : "Total"} {formatCredits(row.cost_micros)}</span></div><div className="grid gap-2 md:grid-cols-3"><DetailGroup title={zh ? "Token 明细" : "Token usage"}>{tokenItems.map(([label, value]) => <DetailLine key={label} label={label} value={Number(value).toLocaleString()} />)}<DetailLine label={zh ? "总 Token" : "Total tokens"} value={Number(row.total_tokens || 0).toLocaleString()} strong /></DetailGroup><DetailGroup title={zh ? "价格（每百万 Token）" : "Prices (per 1M tokens)"}>{priceItems.map(([label, value]) => <DetailLine key={label} label={label} value={formatCredits(value)} />)}</DetailGroup><DetailGroup title={zh ? "费用分解" : "Cost breakdown"}><DetailLine label={zh ? "计费方式" : "Billing mode"} value={row.billing_mode === "coding" ? "Coding Plan" : (zh ? "余额" : "Wallet")} strong />{costItems.map(([label, value]) => <DetailLine key={label} label={label} value={formatCredits(value)} />)}<DetailLine label={zh ? "总费用" : "Total cost"} value={formatCredits(row.cost_micros)} strong /><DetailLine label={zh ? "套餐扣除" : "Plan charged"} value={formatCredits(row.plan_cost_micros)} /><DetailLine label={zh ? "钱包扣除" : "Wallet charged"} value={formatCredits(row.wallet_cost_micros)} /></DetailGroup></div>{row.error ? <p className="mt-2 rounded-md bg-destructive/8 px-3 py-2 text-destructive">{row.error}</p> : null}</div>;
}

function DetailGroup({ title, children }: { title: string; children: ReactNode }) { return <section className="rounded-md bg-card p-3"><p className="mb-2 font-medium text-foreground">{title}</p><div>{children}</div></section>; }
function DetailLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-center justify-between gap-3 py-1 ${strong ? "mt-1 border-t border-border/50 pt-2 font-medium text-foreground" : "text-muted-foreground"}`}><span>{label}</span><span className="font-mono tabular-nums text-foreground/90">{value}</span></div>; }
function OrderStat({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-0.5 truncate font-mono text-[11px] tabular-nums">{value}</p></div>; }
function StatusBadge({ status, zh }: { status: string; zh: boolean }) { const bad = ["failed", "refunded"].includes(status); const good = ["completed", "credited"].includes(status); return <Badge variant={good ? "success" : bad ? "destructive" : "secondary"}>{commerceStatus(status, zh)}</Badge>; }
function signedCredits(value: number) { return `${value > 0 ? "+" : ""}${formatCredits(value)}`; }
function statusLabel(status: string, zh: boolean) { if (!zh) return status === "completed" ? "Done" : status === "pending" ? "Pending" : "Failed"; return status === "completed" ? "完成" : status === "pending" ? "处理中" : "失败"; }
function commerceStatus(status: string, zh: boolean) { const labels: Record<string, string> = zh ? { pending: "待支付", paid: "待入账", credited: "已入账", completed: "已完成", failed: "失败", expired: "已过期", cancelled: "已取消", refunding: "退款中", refunded: "已退款" } : { pending: "Pending", paid: "Paid", credited: "Credited", completed: "Completed", failed: "Failed", expired: "Expired", cancelled: "Cancelled", refunding: "Refunding", refunded: "Refunded" }; return labels[status] || status; }
function kindLabel(kind: string, zh: boolean) { const labels: Record<string, string> = zh ? { wallet_topup: "充值", plan_purchase: "购买套餐", plan_upgrade: "升级套餐", plan_renewal: "手动续费", plan_auto_renewal: "自动续费" } : { wallet_topup: "Top-up", plan_purchase: "Plan purchase", plan_upgrade: "Plan upgrade", plan_renewal: "Renewal", plan_auto_renewal: "Auto renewal" }; return labels[kind] || kind; }
function ledgerType(type: string, zh: boolean) { const labels: Record<string, string> = zh ? { payment_topup: "充值入账", payment_refund: "退款扣回", plan_purchase: "购买套餐", plan_upgrade: "升级套餐", plan_upgrade_credit: "升级预付余额退回", plan_renewal: "套餐续费", usage: "API 用量", adjustment: "管理员调整" } : { payment_topup: "Top-up", payment_refund: "Refund", plan_purchase: "Plan purchase", plan_upgrade: "Plan upgrade", plan_upgrade_credit: "Upgrade credit", plan_renewal: "Plan renewal", usage: "API usage", adjustment: "Adjustment" }; return labels[type] || type; }

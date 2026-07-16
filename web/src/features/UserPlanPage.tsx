import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, CalendarDays, Layers3, Package, RefreshCw, ShoppingBag, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { userApi, type PlanRow, type SubscriptionRow } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppDialog } from "@/components/app-dialog-context";

export function UserPlanPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const me = useQuery({ queryKey: ["user", "me"], queryFn: userApi.me });
  const plans = useQuery({ queryKey: ["user", "plans"], queryFn: userApi.plans.list });
  const subscription = me.data?.subscription;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["user", "me"] });
    qc.invalidateQueries({ queryKey: ["user-me"] });
    qc.invalidateQueries({ queryKey: ["user", "plans"] });
    qc.invalidateQueries({ queryKey: ["user", "commerce-orders"] });
    qc.invalidateQueries({ queryKey: ["user-dashboard"] });
  };
  const autoRenew = useMutation({
    mutationFn: userApi.subscription.setAutoRenew,
    onSuccess: () => { toast.success(zh ? "自动续费设置已更新" : "Auto renewal updated"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const overage = useMutation({
    mutationFn: userApi.subscription.setOverage,
    onSuccess: () => { toast.success(zh ? "超额扣余额设置已更新" : "Wallet overage updated"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const purchase = useMutation({
    mutationFn: userApi.plans.purchase,
    onSuccess: () => { toast.success(zh ? "套餐购买成功" : "Plan purchased"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const upgrade = useMutation({
    mutationFn: userApi.subscription.upgrade,
    onSuccess: () => { toast.success(zh ? "套餐升级成功" : "Plan upgraded"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const renew = useMutation({
    mutationFn: userApi.subscription.renew,
    onSuccess: () => { toast.success(zh ? "套餐续费成功，已延长有效期" : "Plan entitlement extended"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const transactionPending = purchase.isPending || upgrade.isPending || renew.isPending;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "套餐详情" : "Plan details"}
        description={zh ? "购买、升级或续费 Coding Plan；提前续费只延长有效期，不重置当前额度。" : "Purchase, upgrade or renew a Coding Plan."}
        actions={<div className="rounded-md bg-secondary/45 px-3 py-2 text-xs"><span className="text-muted-foreground">{zh ? "余额" : "Balance"}</span><span className="ml-2 font-mono font-medium tabular-nums">{formatCredits(me.data?.wallet?.balance_micros || 0)}</span></div>}
      />

      {subscription ? (
        <PlanDetails
          subscription={subscription}
          zh={zh}
          onAutoRenew={(enabled) => autoRenew.mutate(enabled)}
          onOverage={(enabled) => overage.mutate(enabled)}
          updating={autoRenew.isPending}
          updatingOverage={overage.isPending}
          renewing={renew.isPending}
          onRenew={async () => {
            const price = formatCredits(subscription.plan.price_micros);
            if (await dialogs.confirm({ title: zh ? "续费 Coding Plan" : "Renew Coding Plan", description: zh ? `将扣除 ${price} 余额，并在当前已付有效期后追加一个周期；当前额度不会重置。` : `Charge ${price} and extend the paid entitlement without resetting the current quota.`, confirmText: zh ? "确认续费" : "Renew" })) renew.mutate();
          }}
        />
      ) : (
        <Card><EmptyState>{me.isLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "当前没有生效中的套餐，可从下方选择购买。" : "No active plan. Choose one below.")}</EmptyState></Card>
      )}

      <section className="flex flex-col gap-3">
        <div><h2 className="text-sm font-medium">{zh ? "可选套餐" : "Available plans"}</h2><p className="mt-1 text-[11px] text-muted-foreground">{zh ? "购买和升级均从账户余额扣款；升级会按当前周期剩余时间折抵。" : "Purchases and upgrades are charged from wallet balance."}</p></div>
        {!plans.data?.items.length ? (
          <Card><EmptyState>{plans.isLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无可购买套餐" : "No plans available")}</EmptyState></Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {plans.data.items.map((plan) => (
              <MarketplacePlan
                key={plan.id}
                plan={plan}
                subscription={subscription}
                zh={zh}
                busy={transactionPending}
                onPurchase={async () => {
                  if (await dialogs.confirm({ title: zh ? "购买 Coding Plan" : "Purchase Coding Plan", description: zh ? `确认使用 ${formatCredits(plan.price_micros)} 余额购买 ${plan.name}？` : `Purchase ${plan.name} with wallet balance?`, confirmText: zh ? "确认购买" : "Purchase" })) purchase.mutate(plan.id);
                }}
                onUpgrade={async () => {
                  const cost = estimateUpgradeCost(subscription!, plan);
                  if (await dialogs.confirm({ title: zh ? "升级 Coding Plan" : "Upgrade Coding Plan", description: zh ? `预计补差 ${formatCredits(cost)} 余额。升级后立即开始新周期，当前剩余额度会替换为新套餐额度。` : `Upgrade now for approximately ${formatCredits(cost)}?`, confirmText: zh ? "确认升级" : "Upgrade" })) upgrade.mutate(plan.id);
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PlanDetails({ subscription, zh, onAutoRenew, onOverage, updating, updatingOverage, renewing, onRenew }: { subscription: SubscriptionRow; zh: boolean; onAutoRenew: (enabled: boolean) => void; onOverage: (enabled: boolean) => void; updating: boolean; updatingOverage: boolean; renewing: boolean; onRenew: () => void }) {
  const plan = subscription.plan;
  const available = Math.max(0, subscription.remaining_credits_micros - subscription.reserved_micros);
  const included = Math.max(0, plan.included_credits_micros);
  const used = Math.max(0, included - subscription.remaining_credits_micros);
  const percent = included > 0 ? Math.min(100, Math.max(0, (used / included) * 100)) : 0;
  const dateLocale = zh ? "zh-CN" : "en-US";

  return (
    <>
      <Card className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2"><div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary/60 text-muted-foreground"><Package className="size-4" strokeWidth={1.8} /></div><div className="min-w-0"><h2 className="truncate text-base font-medium">{plan.name}</h2><p className="mt-0.5 text-[11px] text-muted-foreground">Coding Plan · {formatCredits(subscription.price_micros_snapshot || plan.price_micros)} / {plan.cycle_days} {zh ? "天" : "days"}</p></div></div>
            {plan.description ? <p className="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground">{plan.description}</p> : null}
          </div>
          <div className="flex items-center gap-2"><Badge variant="success">{zh ? "生效中" : "Active"}</Badge><Button size="sm" disabled={renewing} onClick={onRenew}>{renewing ? <RefreshCw className="animate-spin" /> : <WalletCards />}{zh ? "立即续费" : "Renew"}</Button></div>
        </div>
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
          <div className="flex min-w-0 flex-col gap-2 rounded-md bg-secondary/35 px-3 py-2.5">
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground">{zh ? "可用套餐额度" : "Available plan credits"}</p>
                <p className="truncate text-xl font-medium tabular-nums tracking-tight">{formatCredits(available)}</p>
              </div>
              <p className="shrink-0 pb-0.5 text-right text-[11px] text-muted-foreground">{zh ? "周期总额" : "Cycle total"} <span className="font-mono text-foreground">{formatCredits(included)}</span></p>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-foreground/75 transition-[width]" style={{ width: `${percent}%` }} /></div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <QuotaMeta label={zh ? "已使用" : "Used"} value={formatCredits(used)} />
              <QuotaMeta label={zh ? "冻结中" : "Reserved"} value={formatCredits(subscription.reserved_micros)} />
              <QuotaMeta label={zh ? "使用率" : "Usage"} value={`${percent.toFixed(percent >= 10 ? 0 : 1)}%`} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Stat label="RPM" value={String(plan.rpm_limit || "∞")} />
            <Stat label="TPM" value={String(plan.tpm_limit || "∞")} />
            <Stat label={zh ? "并发" : "Concurrency"} value={String(plan.concurrency_limit || "∞")} />
            <div className="col-span-3 flex min-w-0 items-center justify-between gap-3 rounded-md bg-secondary/40 px-3 py-2">
              <div className="min-w-0"><p className="text-[11px] text-muted-foreground">{zh ? "调用入口" : "Endpoint"}</p><p className="truncate font-mono text-xs">/coding/v1/*</p></div>
              <Badge variant="secondary">Coding</Badge>
            </div>
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.6fr)]">
          <div className="flex min-w-0 items-start gap-2 rounded-md bg-secondary/35 px-3 py-2.5">
            <Layers3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-[11px] text-muted-foreground">{zh ? "允许模型" : "Allowed models"}</p>
              {plan.allowed_models.length ? <div className="flex flex-wrap gap-1.5">{plan.allowed_models.map((model) => <Badge key={model} variant="secondary" className="max-w-full font-mono"><span className="truncate">{model}</span></Badge>)}</div> : <p className="text-xs">{zh ? "全部已定价模型" : "All administrator-priced models"}</p>}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/40 px-3 py-2.5"><div className="min-w-0"><p className="text-xs">{zh ? "额度用尽后扣余额" : "Use wallet after quota"}</p><p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{plan.overage_enabled ? (zh ? "关闭后，额度不足的 /coding 请求会停止。" : "Disable to stop /coding when quota is exhausted.") : (zh ? "管理员已禁止此套餐超额扣余额。" : "Wallet overage is disabled for this plan.")}</p></div><Switch checked={Boolean(subscription.overage_enabled && plan.overage_enabled)} disabled={updatingOverage || !plan.overage_enabled} onCheckedChange={onOverage} /></div>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4 sm:p-5"><SectionTitle icon={CalendarDays} title={zh ? "套餐周期" : "Plan period"} /><div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><Stat label={zh ? "当前周期开始" : "Cycle starts"} value={new Date(subscription.period_start).toLocaleDateString(dateLocale)} /><Stat label={zh ? "当前额度重置日" : "Quota resets"} value={new Date(subscription.period_end).toLocaleDateString(dateLocale)} /><Stat label={zh ? "已付有效期至" : "Paid through"} value={new Date(subscription.entitlement_end).toLocaleDateString(dateLocale)} /><Stat label={zh ? "周期价格" : "Cycle price"} value={formatCredits(plan.price_micros)} /></div><div className="flex items-center justify-between gap-3 rounded-md bg-secondary/40 px-3 py-2.5"><div><p className="text-xs">{zh ? "自动续费" : "Auto renewal"}</p><p className="mt-1 text-[10px] text-muted-foreground">{zh ? "仅在已付有效期结束时扣款；提前手动续费不会重复扣款。" : "Charged only after paid entitlement ends."}</p></div><Switch checked={Boolean(subscription.auto_renew)} disabled={updating} onCheckedChange={onAutoRenew} /></div></Card>
    </>
  );
}

function MarketplacePlan({ plan, subscription, zh, busy, onPurchase, onUpgrade }: { plan: PlanRow; subscription: SubscriptionRow | null | undefined; zh: boolean; busy: boolean; onPurchase: () => void; onUpgrade: () => void }) {
  const current = subscription?.plan_id === plan.id;
  const soldOut = plan.stock_available === 0 && !current;
  const currentPrice = subscription ? (subscription.price_micros_snapshot || subscription.plan.price_micros) : 0;
  const upgrade = Boolean(subscription && !current && plan.price_micros > currentPrice);
  const estimated = subscription ? estimateUpgradeCost(subscription, plan) : plan.price_micros;
  return (
    <Card className={cn("flex flex-col gap-4 p-4 sm:p-5", current && "ring-1 ring-foreground/15")}>
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-medium">{plan.name}</h3><p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{plan.description || (zh ? "Coding Plan 套餐" : "Coding Plan")}</p></div>{current ? <Badge variant="success">{zh ? "当前套餐" : "Current"}</Badge> : soldOut ? <Badge variant="secondary">{zh ? "售罄" : "Sold out"}</Badge> : null}</div>
      <div><span className="font-mono text-2xl font-medium tabular-nums">{formatCredits(plan.price_micros)}</span><span className="ml-1 text-[11px] text-muted-foreground">/ {plan.cycle_days} {zh ? "天" : "days"}</span></div>
      <div className="grid grid-cols-2 gap-2 text-xs"><Stat label={zh ? "周期额度" : "Credits"} value={formatCredits(plan.included_credits_micros)} /><Stat label={zh ? "剩余库存" : "Stock"} value={plan.stock_available === null ? "∞" : String(plan.stock_available)} /><Stat label="RPM / TPM" value={`${plan.rpm_limit || "∞"} / ${plan.tpm_limit || "∞"}`} /><Stat label={zh ? "并发" : "Concurrency"} value={String(plan.concurrency_limit || "∞")} /></div>
      <p className="line-clamp-2 text-[10px] text-muted-foreground">{plan.allowed_models.length ? plan.allowed_models.join(", ") : (zh ? "支持全部已定价模型" : "All priced models")}</p>
      <div className="mt-auto">
        {!subscription ? <Button className="w-full" size="sm" disabled={busy || soldOut} onClick={onPurchase}><ShoppingBag />{zh ? "购买套餐" : "Purchase"}</Button> : current ? <Button className="w-full" size="sm" variant="secondary" disabled>{zh ? "当前使用中" : "Active"}</Button> : upgrade ? <Button className="w-full" size="sm" disabled={busy || soldOut} onClick={onUpgrade}><ArrowUpCircle />{zh ? `补差 ${formatCredits(estimated)} 升级` : "Upgrade"}</Button> : <Button className="w-full" size="sm" variant="secondary" disabled>{zh ? "暂不支持降级" : "Downgrade unavailable"}</Button>}
      </div>
    </Card>
  );
}

function estimateUpgradeCost(subscription: SubscriptionRow, target: PlanRow) {
  const start = Date.parse(subscription.period_start);
  const end = Date.parse(subscription.period_end);
  const duration = Math.max(1, end - start);
  const remaining = Math.max(0, Math.min(duration, end - Date.now()));
  const currentCredit = Math.floor((subscription.price_micros_snapshot || subscription.plan.price_micros) * remaining / duration);
  const futureDuration = Math.max(0, Date.parse(subscription.entitlement_end) - end);
  const cycleDuration = Math.max(1, subscription.plan.cycle_days * 86_400_000);
  const futureCredit = Math.floor(subscription.plan.price_micros * futureDuration / cycleDuration);
  const credit = currentCredit + futureCredit;
  return Math.max(0, target.price_micros - credit);
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Package; title: string }) {
  return <div className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" strokeWidth={1.8} /><h2 className="text-sm font-medium">{title}</h2></div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-md bg-secondary/40 px-3 py-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono tabular-nums">{value}</p></div>;
}

function QuotaMeta({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="truncate text-muted-foreground">{label}</p><p className="truncate font-mono text-xs tabular-nums">{value}</p></div>;
}

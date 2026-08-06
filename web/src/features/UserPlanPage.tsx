import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  CalendarDays,
  Check,
  Copy,
  Layers3,
  Package,
  RefreshCw,
  ShoppingBag,
  WalletCards,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { userApi, type PlanRow, type SubscriptionRow } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { formatCredits, formatCreditsDisplay } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAppDialog } from "@/components/app-dialog-context";

const CODING_ENDPOINT = "/coding/v1/*";
const MODEL_PREVIEW_COUNT = 3;

export function UserPlanPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const me = useQuery({ queryKey: ["user", "me"], queryFn: userApi.me });
  const plans = useQuery({ queryKey: ["user", "plans"], queryFn: userApi.plans.list });
  const subscription = me.data?.subscription;

  const refresh = () => {
    // M15: a single ["user","me"] / ["user","dashboard"] key is enough —
    // the previous dual invalidation was only needed because some pages
    // used the flat "user-me" / "user-dashboard" aliases.
    qc.invalidateQueries({ queryKey: ["user", "me"] });
    qc.invalidateQueries({ queryKey: ["user", "plans"] });
    qc.invalidateQueries({ queryKey: ["user", "commerce-orders"] });
    qc.invalidateQueries({ queryKey: ["user", "dashboard"] });
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
        description={zh ? "查看额度、续费与升级 Coding Plan。" : "View quota, renew, and upgrade Coding Plan."}
        actions={
          <div className="rounded-lg bg-secondary/45 px-3 py-2 text-xs">
            <span className="text-muted-foreground">{zh ? "余额" : "Balance"}</span>
            <span className="ml-2 font-mono font-medium tabular-nums" title={formatCredits(me.data?.wallet?.balance_micros || 0)}>
              {formatCreditsDisplay(me.data?.wallet?.balance_micros || 0)}
            </span>
          </div>
        }
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
  const dialogs = useAppDialog();
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const plan = subscription.plan;
  const available = Math.max(0, subscription.remaining_credits_micros - subscription.reserved_micros);
  const included = Math.max(0, plan.included_credits_micros);
  const used = Math.max(0, included - subscription.remaining_credits_micros);
  const usedPercent = included > 0 ? Math.min(100, Math.max(0, (used / included) * 100)) : 0;
  const dateLocale = zh ? "zh-CN" : "en-US";
  const periodStart = new Date(subscription.period_start);
  const periodEnd = new Date(subscription.period_end);
  const entitlementEnd = new Date(subscription.entitlement_end);
  const daysToReset = daysUntil(periodEnd);
  const daysToEntitlement = daysUntil(entitlementEnd);
  const prepaidBeyondCycle = entitlementEnd.getTime() - periodEnd.getTime() > 12 * 60 * 60 * 1000;
  const sameResetAndEntitlement = Math.abs(periodEnd.getTime() - entitlementEnd.getTime()) < 12 * 60 * 60 * 1000;
  const cyclePriceDisplay = formatCreditsDisplay(subscription.price_micros_snapshot || plan.price_micros);
  const cyclePriceFull = formatCredits(subscription.price_micros_snapshot || plan.price_micros);
  const overageOn = Boolean(subscription.overage_enabled && plan.overage_enabled);
  const autoRenewOn = Boolean(subscription.auto_renew);
  const models = plan.allowed_models;
  const hiddenModelCount = Math.max(0, models.length - MODEL_PREVIEW_COUNT);
  const visibleModels = modelsExpanded || hiddenModelCount === 0 ? models : models.slice(0, MODEL_PREVIEW_COUNT);
  const progressTone = usedPercent >= 90 ? "bg-destructive/80" : usedPercent >= 75 ? "bg-amber-500/90" : "bg-foreground/75";
  const barWidth = usedPercent > 0 && usedPercent < 0.5 ? 0.5 : usedPercent;

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(CODING_ENDPOINT);
      setEndpointCopied(true);
      toast.success(zh ? "已复制调用入口" : "Endpoint copied");
      window.setTimeout(() => setEndpointCopied(false), 1500);
    } catch {
      toast.error(zh ? "复制失败" : "Copy failed");
    }
  };

  const handleOverage = async (enabled: boolean) => {
    if (!enabled && overageOn) {
      const ok = await dialogs.confirm({
        title: zh ? "关闭超额扣余额" : "Disable wallet overage",
        description: zh
          ? "关闭后，套餐额度不足时 /coding 请求会直接停止，不会再从余额扣费。"
          : "When quota is exhausted, /coding requests will stop instead of charging the wallet.",
        confirmText: zh ? "确认关闭" : "Disable",
        destructive: true,
      });
      if (!ok) return;
    }
    onOverage(enabled);
  };

  const handleAutoRenew = async (enabled: boolean) => {
    if (!enabled && autoRenewOn) {
      const ok = await dialogs.confirm({
        title: zh ? "关闭自动续费" : "Disable auto renewal",
        description: zh
          ? `关闭后不会在已付有效期结束时自动扣款。当前有效期至 ${entitlementEnd.toLocaleDateString(dateLocale)}。`
          : `Won't charge when paid entitlement ends. Current entitlement ends ${entitlementEnd.toLocaleDateString(dateLocale)}.`,
        confirmText: zh ? "确认关闭" : "Disable",
        destructive: true,
      });
      if (!ok) return;
    }
    onAutoRenew(enabled);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Current plan summary */}
      <Card className="flex flex-col gap-5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-medium tracking-tight">{plan.name}</h2>
              <Badge variant="success">{zh ? "生效中" : "Active"}</Badge>
              {autoRenewOn ? <Badge variant="secondary">{zh ? "自动续费" : "Auto-renew"}</Badge> : null}
            </div>
            {plan.description ? (
              <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground line-clamp-2" title={plan.description}>
                {plan.description}
              </p>
            ) : null}
            <p className="mt-2 text-[11px] text-muted-foreground">
              <span className="font-mono tabular-nums text-foreground" title={cyclePriceFull}>{cyclePriceDisplay}</span>
              <span> / {plan.cycle_days}{zh ? " 天" : "d"}</span>
              <span className="mx-1.5 text-border">·</span>
              {zh ? "重置" : "Resets"} {periodEnd.toLocaleDateString(dateLocale)}
              <span className="ml-1">({formatDaysLeft(daysToReset, zh, "reset")})</span>
            </p>
          </div>
          <Button size="sm" disabled={renewing} onClick={onRenew}>
            {renewing ? <RefreshCw className="animate-spin" /> : <WalletCards />}
            {zh ? "立即续费" : "Renew"}
          </Button>
        </div>

        <div className="rounded-lg bg-secondary/40 px-3.5 py-3.5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground">{zh ? "可用额度" : "Available"}</p>
              <p className="mt-1 font-mono text-2xl font-medium tabular-nums tracking-tight" title={formatCredits(available)}>
                {formatCreditsDisplay(available)}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  / {formatCreditsDisplay(included)}
                </span>
              </p>
            </div>
            <div className="text-right text-[11px] text-muted-foreground">
              <p>
                {zh ? "已用" : "Used"}{" "}
                <span className="font-mono tabular-nums text-foreground">{formatCreditsDisplay(used)}</span>
                <span className="mx-1 text-border">·</span>
                {formatUsagePercent(usedPercent)}
              </p>
              {subscription.reserved_micros > 0 ? (
                <p className="mt-1">
                  {zh ? "冻结" : "Reserved"}{" "}
                  <span className="font-mono tabular-nums text-foreground">
                    {formatCreditsDisplay(subscription.reserved_micros)}
                  </span>
                </p>
              ) : null}
            </div>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-background/80"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Number(usedPercent.toFixed(1))}
            aria-label={zh ? "额度使用进度" : "Quota usage"}
          >
            <div
              className={cn("h-full min-w-0 rounded-full transition-[width,background-color]", progressTone)}
              style={{ width: `${barWidth}%` }}
            />
          </div>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <SectionTitle icon={Layers3} title={zh ? "访问与限速" : "Access & limits"} />
          <div className="grid grid-cols-3 gap-2">
            <SoftStat label="RPM" value={formatLimit(plan.rpm_limit, zh)} muted={!plan.rpm_limit} />
            <SoftStat label="TPM" value={formatLimit(plan.tpm_limit, zh)} muted={!plan.tpm_limit} />
            <SoftStat label={zh ? "并发" : "Concurrency"} value={formatLimit(plan.concurrency_limit, zh)} muted={!plan.concurrency_limit} />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary/40 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground">{zh ? "调用入口" : "Endpoint"}</p>
              <p className="mt-0.5 truncate font-mono text-xs">{CODING_ENDPOINT}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground"
              onClick={copyEndpoint}
              aria-label={zh ? "复制调用入口" : "Copy endpoint"}
            >
              {endpointCopied ? <Check className="size-3.5" strokeWidth={1.8} /> : <Copy className="size-3.5" strokeWidth={1.8} />}
            </Button>
          </div>

          <div className="rounded-lg bg-secondary/35 px-3 py-2.5">
            <p className="text-[11px] text-muted-foreground">{zh ? "允许模型" : "Allowed models"}</p>
            {models.length ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {visibleModels.map((model) => (
                  <Badge key={model} variant="secondary" className="max-w-full font-mono" title={model}>
                    <span className="truncate">{model}</span>
                  </Badge>
                ))}
                {hiddenModelCount > 0 ? (
                  <button
                    type="button"
                    className="inline-flex h-5 items-center rounded-full bg-secondary/70 px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setModelsExpanded((v) => !v)}
                  >
                    {modelsExpanded ? (zh ? "收起" : "Less") : `+${hiddenModelCount}`}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-xs">{zh ? "全部已定价模型" : "All administrator-priced models"}</p>
            )}
          </div>
        </Card>

        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <SectionTitle icon={CalendarDays} title={zh ? "周期与续费" : "Period & renewal"} />
          </div>

          <div className={cn("grid gap-2", sameResetAndEntitlement ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-3")}>
            <SoftStat label={zh ? "周期开始" : "Cycle starts"} value={periodStart.toLocaleDateString(dateLocale)} />
            {sameResetAndEntitlement ? (
              <SoftStat
                label={zh ? "重置 / 有效期" : "Reset / paid through"}
                value={periodEnd.toLocaleDateString(dateLocale)}
                hint={formatDaysLeft(daysToReset, zh, "end")}
              />
            ) : (
              <>
                <SoftStat
                  label={zh ? "额度重置" : "Quota resets"}
                  value={periodEnd.toLocaleDateString(dateLocale)}
                  hint={formatDaysLeft(daysToReset, zh, "reset")}
                />
                <SoftStat
                  label={zh ? "已付有效期" : "Paid through"}
                  value={entitlementEnd.toLocaleDateString(dateLocale)}
                  hint={prepaidBeyondCycle ? (zh ? "含预付" : "Prepaid") : formatDaysLeft(daysToEntitlement, zh, "end")}
                />
              </>
            )}
          </div>

          {prepaidBeyondCycle ? (
            <p className="text-[11px] text-muted-foreground">
              {zh
                ? "提前续费只延长有效期，不会重置当前额度。"
                : "Early renewal extends entitlement only; current quota is unchanged."}
            </p>
          ) : null}

          <div className="mt-auto flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-xs">{zh ? "额度用尽后扣余额" : "Use wallet after quota"}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {plan.overage_enabled
                    ? overageOn
                      ? (zh ? "开启后从余额继续扣费" : "Charge wallet when quota runs out")
                      : (zh ? "关闭后 /coding 会停止" : "Stop /coding when quota runs out")
                    : (zh ? "此套餐不允许超额" : "Overage disabled for this plan")}
                </p>
              </div>
              <Switch
                checked={overageOn}
                disabled={updatingOverage || !plan.overage_enabled}
                onCheckedChange={handleOverage}
                aria-label={zh ? "额度用尽后扣余额" : "Use wallet after quota"}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-xs">{zh ? "自动续费" : "Auto renewal"}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {autoRenewOn
                    ? (zh
                      ? `开启：到期扣 ${cyclePriceDisplay}`
                      : `On: charge ${cyclePriceDisplay} at expiry`)
                    : (zh
                      ? "关闭：到期需手动续费"
                      : "Off: renew manually")}
                </p>
              </div>
              <Switch
                checked={autoRenewOn}
                disabled={updating}
                onCheckedChange={handleAutoRenew}
                aria-label={zh ? "自动续费" : "Auto renewal"}
              />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SoftStat({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-secondary/40 px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("mt-1 truncate font-mono text-sm tabular-nums", muted && "text-muted-foreground")}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function MarketplacePlan({ plan, subscription, zh, busy, onPurchase, onUpgrade }: { plan: PlanRow; subscription: SubscriptionRow | null | undefined; zh: boolean; busy: boolean; onPurchase: () => void; onUpgrade: () => void }) {
  const current = subscription?.plan_id === plan.id;
  const soldOut = plan.stock_available === 0 && !current;
  const currentPrice = subscription ? (subscription.price_micros_snapshot || subscription.plan.price_micros) : 0;
  const upgrade = Boolean(subscription && !current && plan.price_micros > currentPrice);
  const estimated = subscription ? estimateUpgradeCost(subscription, plan) : plan.price_micros;
  return (
    <Card className={cn("flex flex-col gap-4 p-4 sm:p-5", current && "bg-secondary/20")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">{plan.name}</h3>
          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{plan.description || (zh ? "Coding Plan 套餐" : "Coding Plan")}</p>
        </div>
        {soldOut ? <Badge variant="secondary">{zh ? "售罄" : "Sold out"}</Badge> : null}
      </div>
      <div>
        <span className="font-mono text-2xl font-medium tabular-nums" title={formatCredits(plan.price_micros)}>{formatCreditsDisplay(plan.price_micros)}</span>
        <span className="ml-1 text-[11px] text-muted-foreground">/ {plan.cycle_days} {zh ? "天" : "days"}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label={zh ? "周期额度" : "Credits"} value={formatCreditsDisplay(plan.included_credits_micros)} title={formatCredits(plan.included_credits_micros)} />
        <Stat label={zh ? "剩余库存" : "Stock"} value={plan.stock_available === null ? (zh ? "不限" : "∞") : String(plan.stock_available)} />
        <Stat label="RPM / TPM" value={`${formatLimit(plan.rpm_limit, zh)} / ${formatLimit(plan.tpm_limit, zh)}`} />
        <Stat label={zh ? "并发" : "Concurrency"} value={formatLimit(plan.concurrency_limit, zh)} />
      </div>
      <p className="line-clamp-2 text-[10px] text-muted-foreground">
        {plan.allowed_models.length ? plan.allowed_models.join(", ") : (zh ? "支持全部已定价模型" : "All priced models")}
      </p>
      <div className="mt-auto">
        {!subscription ? (
          <Button className="w-full" size="sm" disabled={busy || soldOut} onClick={onPurchase}><ShoppingBag />{zh ? "购买套餐" : "Purchase"}</Button>
        ) : current ? (
          <Button className="w-full" size="sm" variant="secondary" disabled>{zh ? "当前使用中" : "Active"}</Button>
        ) : upgrade ? (
          <Button className="w-full" size="sm" disabled={busy || soldOut} onClick={onUpgrade}><ArrowUpCircle />{zh ? `补差 ${formatCreditsDisplay(estimated)} 升级` : "Upgrade"}</Button>
        ) : (
          <Button className="w-full" size="sm" variant="secondary" disabled>{zh ? "暂不支持降级" : "Downgrade unavailable"}</Button>
        )}
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

function daysUntil(date: Date) {
  const ms = date.getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

function formatDaysLeft(days: number, zh: boolean, kind: "reset" | "end") {
  if (days <= 0) {
    if (kind === "reset") return zh ? "今日重置" : "Resets today";
    return zh ? "已到期" : "Ended";
  }
  if (days === 1) return zh ? "还剩 1 天" : "1 day left";
  return zh ? `还剩 ${days} 天` : `${days} days left`;
}

function formatUsagePercent(percent: number) {
  if (percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
}

function formatLimit(value: number | null | undefined, zh: boolean) {
  if (!value) return zh ? "不限" : "∞";
  return String(value);
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Package; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" strokeWidth={1.8} />
      <h2 className="text-sm font-medium">{title}</h2>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  title,
  mutedInfinite,
}: {
  label: string;
  value: string;
  hint?: string;
  title?: string;
  mutedInfinite?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-secondary/40 px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={cn("mt-1 truncate font-mono tabular-nums", mutedInfinite && "text-muted-foreground")}
        title={title || value}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

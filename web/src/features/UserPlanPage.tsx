import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Gauge,
  Layers3,
  Package,
  RefreshCw,
  ShoppingBag,
  WalletCards,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { userApi, type PlanRow, type SubscriptionRow, type UsageTrendPoint } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
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
    onSuccess: () => { toast.success(zh ? "套餐购买成功" : "Plan purchased"); setMarketplaceOpen(false); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const upgrade = useMutation({
    mutationFn: userApi.subscription.upgrade,
    onSuccess: () => { toast.success(zh ? "套餐升级成功" : "Plan upgraded"); setMarketplaceOpen(false); refresh(); },
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
        title={zh ? "我的套餐" : "My plan"}
        description={zh ? "查看套餐用量、续费与升级 Coding Plan。" : "Track plan usage, renew, and upgrade Coding Plan."}
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
        <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
          <PlanInfoPanel
            subscription={subscription}
            zh={zh}
            onAutoRenew={(enabled) => autoRenew.mutate(enabled)}
            onOverage={(enabled) => overage.mutate(enabled)}
            updating={autoRenew.isPending}
            updatingOverage={overage.isPending}
            renewing={renew.isPending}
            onUpgradeClick={() => setMarketplaceOpen(true)}
            onRenew={async () => {
              const price = formatCredits(subscription.plan.price_micros);
              if (await dialogs.confirm({ title: zh ? "续费 Coding Plan" : "Renew Coding Plan", description: zh ? `将扣除 ${price} 余额，并在当前已付有效期后追加一个周期；当前额度不会重置。` : `Charge ${price} and extend the paid entitlement without resetting the current quota.`, confirmText: zh ? "确认续费" : "Renew" })) renew.mutate();
            }}
          />
          <div className="flex min-w-0 flex-col gap-4">
            <UsageStatsCard subscription={subscription} zh={zh} />
            <ModelUsageDetail zh={zh} />
          </div>
        </div>
      ) : (
        <Card>
          <EmptyState>
            {me.isLoading ? (
              zh ? "加载中…" : "Loading…"
            ) : (
              <div className="flex flex-col items-center gap-3">
                <p>{zh ? "当前没有生效中的套餐。" : "No active plan."}</p>
                <Button size="sm" onClick={() => setMarketplaceOpen(true)}>
                  <ShoppingBag />
                  {zh ? "订购套餐" : "Subscribe"}
                </Button>
              </div>
            )}
          </EmptyState>
        </Card>
      )}

      <Dialog open={marketplaceOpen} onOpenChange={setMarketplaceOpen}>
        <DialogContent className="max-w-[920px]">
          <DialogHeader>
            <DialogTitle>{zh ? "可选套餐" : "Available plans"}</DialogTitle>
            <DialogDescription>
              {zh ? "购买和升级均从账户余额扣款；升级会按当前周期剩余时间折抵。" : "Purchases and upgrades are charged from wallet balance; upgrades are prorated by remaining cycle time."}
            </DialogDescription>
          </DialogHeader>
          {!plans.data?.items.length ? (
            <EmptyState>{plans.isLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无可购买套餐" : "No plans available")}</EmptyState>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlanInfoPanel({ subscription, zh, onAutoRenew, onOverage, updating, updatingOverage, renewing, onRenew, onUpgradeClick }: { subscription: SubscriptionRow; zh: boolean; onAutoRenew: (enabled: boolean) => void; onOverage: (enabled: boolean) => void; updating: boolean; updatingOverage: boolean; renewing: boolean; onRenew: () => void; onUpgradeClick: () => void }) {
  const dialogs = useAppDialog();
  const [benefitsOpen, setBenefitsOpen] = useState(false);
  const [overageOpen, setOverageOpen] = useState(false);
  const plan = subscription.plan;
  const dateLocale = zh ? "zh-CN" : "en-US";
  const periodStart = new Date(subscription.period_start);
  const entitlementEnd = new Date(subscription.entitlement_end);
  const daysToEntitlement = daysUntil(entitlementEnd);
  const cyclePriceDisplay = formatCreditsDisplay(subscription.price_micros_snapshot || plan.price_micros);
  const cyclePriceFull = formatCredits(subscription.price_micros_snapshot || plan.price_micros);
  const overageOn = Boolean(subscription.overage_enabled && plan.overage_enabled);
  const autoRenewOn = Boolean(subscription.auto_renew);
  const included = Math.max(0, plan.included_credits_micros);

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
    <div className="flex flex-col lg:sticky lg:top-8">
      <h2 className="text-sm font-medium">{zh ? "套餐信息" : "Plan info"}</h2>

      <div className="mt-2 flex flex-col">
        <InfoRow label={zh ? "套餐类型" : "Plan"}>
          <Badge variant="secondary" className="max-w-full" title={plan.name}>
            <span className="truncate">{plan.name}</span>
          </Badge>
        </InfoRow>
        <InfoRow label={zh ? "套餐限额" : "Quota"}>
          <span className="font-mono tabular-nums" title={formatCredits(included)}>
            {formatCreditsDisplay(included)}
            <span className="text-muted-foreground"> / {plan.cycle_days}{zh ? " 天" : "d"}</span>
          </span>
        </InfoRow>
        <InfoRow label={zh ? "订阅状态" : "Status"}>
          <Badge variant="success">{zh ? "生效中" : "Active"}</Badge>
        </InfoRow>
        <InfoRow label={zh ? "开始时间" : "Started"}>
          <span className="font-mono tabular-nums">{formatDateTime(periodStart, dateLocale)}</span>
        </InfoRow>
        <InfoRow label={zh ? "结束时间" : "Ends"}>
          <span className="font-mono tabular-nums">{formatDateTime(entitlementEnd, dateLocale)}</span>
        </InfoRow>
        <InfoRow label={zh ? "剩余时间" : "Time left"}>
          <span className="font-mono tabular-nums">
            {daysToEntitlement > 0 ? (zh ? `${daysToEntitlement} 天` : `${daysToEntitlement} days`) : (zh ? "已到期" : "Ended")}
          </span>
        </InfoRow>
        <InfoRow label={zh ? "计费模式" : "Billing"}>
          <span title={cyclePriceFull}>
            {zh ? "按周期" : "Per cycle"} · <span className="font-mono tabular-nums">{cyclePriceDisplay}</span>
          </span>
        </InfoRow>
        <InfoRow label={zh ? "自动续费" : "Auto renewal"}>
          <Switch
            checked={autoRenewOn}
            disabled={updating}
            onCheckedChange={handleAutoRenew}
            aria-label={zh ? "自动续费" : "Auto renewal"}
          />
        </InfoRow>
        <InfoRow label={zh ? "查看权益" : "Benefits"}>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setBenefitsOpen((v) => !v)}
            aria-expanded={benefitsOpen}
          >
            {zh ? "查看详情" : "View details"}
            <ChevronDown className={cn("size-3.5 transition-transform", benefitsOpen && "rotate-180")} strokeWidth={1.8} />
          </button>
        </InfoRow>
      </div>

      {benefitsOpen ? (
        <div className="mt-1 flex flex-col gap-2 rounded-lg bg-secondary/35 px-3 py-2.5">
          <div className="grid grid-cols-3 gap-2 text-center">
            <MiniStat label="RPM" value={formatLimit(plan.rpm_limit, zh)} />
            <MiniStat label="TPM" value={formatLimit(plan.tpm_limit, zh)} />
            <MiniStat label={zh ? "并发" : "Conc."} value={formatLimit(plan.concurrency_limit, zh)} />
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">{zh ? "允许模型" : "Allowed models"}</p>
            {plan.allowed_models.length ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {plan.allowed_models.map((model) => (
                  <Badge key={model} variant="secondary" className="max-w-full font-mono" title={model}>
                    <span className="truncate">{model}</span>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs">{zh ? "全部已定价模型" : "All administrator-priced models"}</p>
            )}
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-2">
        <Button className="w-full" disabled={renewing} onClick={onRenew}>
          {renewing ? <RefreshCw className="animate-spin" /> : <WalletCards />}
          {zh ? "续费套餐" : "Renew plan"}
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button className="w-full" variant="outline" onClick={onUpgradeClick}>
            <ArrowUpCircle />
            {zh ? "升级套餐" : "Upgrade plan"}
          </Button>
          <Button className="w-full" variant="outline" onClick={() => setOverageOpen((v) => !v)} aria-expanded={overageOpen}>
            <Gauge />
            {zh ? "超额管理" : "Overage"}
          </Button>
        </div>
      </div>

      {overageOpen ? (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-secondary/40 px-3 py-2.5">
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
      ) : null}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/30 py-3 text-xs last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-background/70 px-2 py-1.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate font-mono text-[11px] tabular-nums">{value}</p>
    </div>
  );
}

function UsageStatsCard({ subscription, zh }: { subscription: SubscriptionRow; zh: boolean }) {
  const [tab, setTab] = useState<"usage" | "config">("usage");
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const plan = subscription.plan;
  const dateLocale = zh ? "zh-CN" : "en-US";
  const included = Math.max(0, plan.included_credits_micros);
  const used = Math.max(0, included - subscription.remaining_credits_micros);
  const available = Math.max(0, subscription.remaining_credits_micros - subscription.reserved_micros);
  const usedPercent = included > 0 ? Math.min(100, Math.max(0, (used / included) * 100)) : 0;
  const periodStart = new Date(subscription.period_start);
  const periodEnd = new Date(subscription.period_end);
  const cycleMs = Math.max(1, periodEnd.getTime() - periodStart.getTime());
  const elapsedMs = Math.min(cycleMs, Math.max(0, Date.now() - periodStart.getTime()));
  const timePercent = Math.min(100, (elapsedMs / cycleMs) * 100);
  const elapsedDays = Math.floor(elapsedMs / 86_400_000);
  const cycleDays = Math.max(1, Math.round(cycleMs / 86_400_000));
  const daysToReset = daysUntil(periodEnd);
  const progressTone = usedPercent >= 90 ? "bg-destructive/80" : usedPercent >= 75 ? "bg-amber-500/90" : "bg-foreground/75";
  const barWidth = usedPercent > 0 && usedPercent < 0.5 ? 0.5 : usedPercent;
  const models = plan.allowed_models;
  const hiddenModelCount = Math.max(0, models.length - MODEL_PREVIEW_COUNT);
  const visibleModels = modelsExpanded || hiddenModelCount === 0 ? models : models.slice(0, MODEL_PREVIEW_COUNT);

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

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2 sm:px-5">
        <div className="flex items-center gap-1" role="tablist" aria-label={zh ? "用量与配置" : "Usage and config"}>
          {([
            ["usage", zh ? "用量统计" : "Usage"],
            ["config", zh ? "使用配置" : "Config"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                "flex h-7 items-center rounded-full px-3 text-xs transition-colors",
                tab === key
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
          onClick={copyEndpoint}
        >
          {endpointCopied ? <Check className="size-3.5" strokeWidth={1.8} /> : <Copy className="size-3.5" strokeWidth={1.8} />}
          {zh ? "复制调用入口" : "Copy endpoint"}
        </Button>
      </div>

      {tab === "usage" ? (
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          <div>
            <h3 className="text-sm font-medium">{plan.name} {zh ? "额度用量" : "quota usage"}</h3>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              {zh
                ? "该部分为套餐内额度实时统计数据；重置时间按当前计费周期计算。"
                : "Live in-plan quota usage; reset follows the current billing cycle."}
            </p>
          </div>

          <UsageBar
            label={zh ? "本周期额度用量" : "Cycle quota usage"}
            resetHint={formatDaysLeft(daysToReset, zh)}
            usedText={formatCreditsDisplay(used)}
            usedTitle={formatCredits(used)}
            totalText={formatCreditsDisplay(included)}
            percent={usedPercent}
            barWidth={barWidth}
            tone={progressTone}
            zh={zh}
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/30 pt-3 text-[11px] text-muted-foreground">
            <span>
              {zh ? "剩余可用" : "Available"}{" "}
              <span className="font-mono tabular-nums text-foreground" title={formatCredits(available)}>
                {formatCreditsDisplay(available)}
              </span>
            </span>
            {subscription.reserved_micros > 0 ? (
              <span>
                {zh ? "冻结" : "Reserved"}{" "}
                <span className="font-mono tabular-nums text-foreground">{formatCreditsDisplay(subscription.reserved_micros)}</span>
              </span>
            ) : null}
            <span>
              {zh ? "周期进度" : "Cycle elapsed"}{" "}
              <span className="font-mono tabular-nums text-foreground">
                {zh ? `${elapsedDays} / ${cycleDays} 天` : `${elapsedDays} / ${cycleDays}d`}
                <span className="text-muted-foreground"> · {formatUsagePercent(timePercent)}</span>
              </span>
            </span>
            <span>
              {zh ? "重置时间" : "Resets at"}{" "}
              <span className="font-mono tabular-nums text-foreground">{formatDateTime(periodEnd, dateLocale)}</span>
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4 sm:p-5">
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
        </div>
      )}
    </Card>
  );
}

function UsageBar({ label, resetHint, usedText, usedTitle, totalText, percent, barWidth, tone, zh }: { label: string; resetHint: string; usedText: string; usedTitle?: string; totalText: string; percent: number; barWidth: number; tone: string; zh: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate">{label}</span>
          <Clock3 className="size-3 shrink-0" strokeWidth={1.8} />
          <span className="shrink-0">{resetHint}</span>
        </span>
        <span className="shrink-0">{zh ? "已使用" : "Used"} {formatUsagePercent(percent)}</span>
      </div>
      <p className="mt-1.5 font-mono text-lg font-medium tabular-nums tracking-tight" title={usedTitle}>
        {usedText}
        <span className="ml-1.5 text-xs font-normal text-muted-foreground">/ {totalText}</span>
      </p>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-secondary/70"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(percent.toFixed(1))}
        aria-label={label}
      >
        <div className={cn("h-full min-w-0 rounded-full transition-[width,background-color]", tone)} style={{ width: `${barWidth}%` }} />
      </div>
    </div>
  );
}

type DetailMetric = "tokens" | "requests" | "cost";
const STACK_OPACITIES = [0.85, 0.6, 0.42, 0.28, 0.18];
const OTHER_OPACITY = 0.1;
const STACK_LIMIT = STACK_OPACITIES.length;

const METRIC_VALUE: Record<DetailMetric, (row: UsageTrendPoint) => number> = {
  tokens: (row) => row.total_tokens,
  requests: (row) => row.requests,
  cost: (row) => row.cost_micros / 1_000_000,
};

function ModelUsageDetail({ zh }: { zh: boolean }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["user", "dashboard"], queryFn: userApi.dashboard, staleTime: 10_000 });
  const [metric, setMetric] = useState<DetailMetric>("tokens");
  const [model, setModel] = useState<string | null>(null);
  const trend = useMemo(() => query.data?.trend ?? [], [query.data?.trend]);
  const trendByModel = useMemo(() => query.data?.trendByModel ?? [], [query.data?.trendByModel]);

  const metricValue = METRIC_VALUE[metric];
  const metricDef = {
    tokens: { label: "Tokens", format: (value: number) => Math.round(value).toLocaleString() },
    requests: { label: zh ? "请求次数" : "Requests", format: (value: number) => Math.round(value).toLocaleString() },
    cost: { label: zh ? "费用" : "Cost", format: (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 4 }) },
  }[metric];

  const models = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of trendByModel) totals.set(row.model, (totals.get(row.model) || 0) + metricValue(row));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [trendByModel, metricValue]);
  const activeModel = model && models.includes(model) ? model : null;

  const dates = useMemo(() => (trend.length ? trend.map((row) => row.date) : last30Dates()), [trend]);

  // Stacked series: top models by the active metric, remainder folded into "其他".
  const { series, perDate } = useMemo(() => {
    const stackModels = activeModel ? [activeModel] : models.slice(0, STACK_LIMIT);
    const useOther = !activeModel && models.length > STACK_LIMIT;
    const seriesNames = useOther ? [...stackModels, "__other__"] : stackModels;
    const byDateModel = new Map<string, Map<string, number>>();
    for (const row of trendByModel) {
      if (activeModel && row.model !== activeModel) continue;
      let bucket = row.model;
      if (!stackModels.includes(bucket)) bucket = "__other__";
      if (!seriesNames.includes(bucket)) continue;
      const day = byDateModel.get(row.date) || new Map<string, number>();
      day.set(bucket, (day.get(bucket) || 0) + metricValue(row));
      byDateModel.set(row.date, day);
    }
    const perDateRows = dates.map((date) => {
      const day = byDateModel.get(date);
      const values = seriesNames.map((name) => day?.get(name) || 0);
      return { date, values, total: values.reduce((sum, value) => sum + value, 0) };
    });
    return { series: seriesNames, perDate: perDateRows };
  }, [dates, trendByModel, models, activeModel, metricValue]);

  const total = perDate.reduce((sum, row) => sum + row.total, 0);
  const hasData = perDate.some((row) => row.total > 0);

  const chart = useMemo(() => {
    const width = 1000;
    const height = 280;
    const left = 54;
    const right = 16;
    const top = 18;
    const bottom = 34;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const maxValue = Math.max(1, ...perDate.map((row) => row.total));
    const band = plotWidth / Math.max(1, perDate.length);
    const barWidth = Math.max(4, Math.min(30, band * 0.55));
    const y = (value: number) => top + plotHeight - (value / maxValue) * plotHeight;
    return { width, height, left, right, top, bottom, plotWidth, plotHeight, maxValue, band, barWidth, y };
  }, [perDate]);

  const seriesLabel = (name: string) => (name === "__other__" ? (zh ? "其他" : "Other") : name);
  const seriesOpacity = (index: number, name: string) => (name === "__other__" ? OTHER_OPACITY : STACK_OPACITIES[index % STACK_OPACITIES.length]);
  const xLabels = perDate.length ? Array.from(new Set([0, Math.floor((perDate.length - 1) / 2), perDate.length - 1])) : [];
  const dateRange = perDate.length ? `${perDate[0].date} ~ ${perDate[perDate.length - 1].date}` : "";

  return (
    <Card className="overflow-hidden p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{zh ? "模型调用明细" : "Model usage detail"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {metricDef.label} <span className="ml-1 font-mono tabular-nums text-foreground">{metricDef.format(total)}</span>
            {dateRange ? <span className="ml-2 font-mono tabular-nums">{dateRange}</span> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {models.length ? (
            <select
              className="h-8 max-w-48 rounded-md border border-input bg-secondary/55 px-3 text-xs outline-none focus:bg-background focus:ring-1 focus:ring-ring"
              value={activeModel ?? ""}
              onChange={(event) => setModel(event.target.value || null)}
              aria-label={zh ? "模型筛选" : "Model filter"}
            >
              <option value="">{zh ? "全部模型" : "All models"}</option>
              {models.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          ) : null}
          <div className="inline-flex h-8 rounded-md bg-muted p-0.5" aria-label={zh ? "图表指标" : "Chart metric"}>
            {(["tokens", "requests", "cost"] as const).map((item) => {
              const label = item === "tokens" ? "Tokens" : item === "requests" ? (zh ? "请求" : "Requests") : (zh ? "费用" : "Cost");
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={metric === item}
                  onClick={() => setMetric(item)}
                  className={cn("rounded-[5px] px-3 text-[11px] text-muted-foreground transition-colors", metric === item && "bg-background text-foreground shadow-sm")}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            onClick={() => qc.invalidateQueries({ queryKey: ["user", "dashboard"] })}
            aria-label={zh ? "刷新" : "Refresh"}
          >
            <RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} strokeWidth={1.8} />
          </Button>
        </div>
      </div>

      <div className="mt-4 h-[220px] w-full text-foreground sm:h-[280px]">
        {query.isLoading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{zh ? "加载中…" : "Loading…"}</div>
        ) : !hasData ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ChartNoAxesCombined className="size-5" strokeWidth={1.6} />
            <p className="text-xs">{zh ? "暂无调用数据" : "No usage data yet"}</p>
            <p className="text-[11px]">{zh ? "发起一次 API 调用后，这里会显示模型明细。" : "Make an API call and per-model usage will appear here."}</p>
          </div>
        ) : (
          <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={zh ? "模型调用堆叠柱状图" : "stacked model usage chart"}>
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = chart.top + chart.plotHeight * (1 - ratio);
              return (
                <g key={ratio}>
                  <line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} className="stroke-border/70" strokeWidth="1" />
                  <text x={chart.left - 10} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">{formatCompact(chart.maxValue * ratio)}</text>
                </g>
              );
            })}
            {perDate.map((row, index) => {
              const x = chart.left + index * chart.band + (chart.band - chart.barWidth) / 2;
              let acc = 0;
              return (
                <g key={row.date}>
                  {row.values.map((value, seriesIndex) => {
                    if (value <= 0) return null;
                    const y1 = chart.y(acc + value);
                    const y0 = chart.y(acc);
                    acc += value;
                    return (
                      <rect
                        key={series[seriesIndex]}
                        x={x}
                        y={y1}
                        width={chart.barWidth}
                        height={Math.max(0.5, y0 - y1)}
                        rx={1}
                        fill="currentColor"
                        fillOpacity={seriesOpacity(seriesIndex, series[seriesIndex])}
                      />
                    );
                  })}
                  <rect x={chart.left + index * chart.band} y={chart.top} width={chart.band} height={chart.plotHeight} fill="transparent">
                    <title>{`${row.date}: ${metricDef.format(row.total)}`}</title>
                  </rect>
                </g>
              );
            })}
            {xLabels.map((index) => (
              <text key={index} x={chart.left + index * chart.band + chart.band / 2} y={chart.height - 8} textAnchor={index === 0 ? "start" : index === perDate.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px]">
                {formatDate(perDate[index].date, zh)}
              </text>
            ))}
          </svg>
        )}
      </div>

      {series.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {series.map((name, index) => (
            <span key={name} className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-2 shrink-0 rounded-[2px] bg-foreground" style={{ opacity: seriesOpacity(index, name) }} />
              <span className="max-w-48 truncate font-mono" title={seriesLabel(name)}>{seriesLabel(name)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </Card>
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

function formatDaysLeft(days: number, zh: boolean) {
  if (days <= 0) return zh ? "今日重置" : "Resets today";
  if (days === 1) return zh ? "1 天后重置" : "Resets in 1 day";
  return zh ? `${days} 天后重置` : `Resets in ${days} days`;
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

function formatDateTime(date: Date, locale: string) {
  return date.toLocaleString(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** UTC+8 date list for the last 30 days, used only when the trend is empty. */
function last30Dates(): string[] {
  const nowUtc8 = Date.now() + 8 * 3_600_000;
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    days.push(new Date(nowUtc8 - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function formatCompact(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (!Number.isInteger(value)) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString();
}

function formatDate(value: string, zh: boolean) {
  const [, month, day] = value.split("-");
  return zh ? `${Number(month)}/${Number(day)}` : `${month}/${day}`;
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Package; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" strokeWidth={1.8} />
      <h2 className="text-sm font-medium">{title}</h2>
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

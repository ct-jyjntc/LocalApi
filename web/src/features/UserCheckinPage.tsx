import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarCheck2, Coins, Gift } from "lucide-react";
import { userApi } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserCheckinPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["user", "checkin"], queryFn: userApi.checkin.status, refetchInterval: 30_000 });
  const [exchangePoints, setExchangePoints] = useState("10.00");

  const data = status.data;
  const settings = data?.settings;
  const points = data?.points;
  const formatPts = (value: number | null | undefined) =>
    Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const exchangePreview = useMemo(() => {
    const n = Math.round((Number(exchangePoints) || 0) * 100) / 100;
    const rate = settings?.exchange_rate ?? 0;
    return { points: n, credits: n > 0 ? n * rate : 0 };
  }, [exchangePoints, settings?.exchange_rate]);

  const checkin = useMutation({
    mutationFn: userApi.checkin.perform,
    onSuccess: (result) => {
      toast.success(
        zh
          ? `签到成功，获得 ${Number(result.record.points).toFixed(2)} 积分`
          : `Checked in: +${Number(result.record.points).toFixed(2)} points`,
      );
      qc.setQueryData(["user", "checkin"], result.status);
      qc.invalidateQueries({ queryKey: ["user", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["user", "me"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const exchange = useMutation({
    mutationFn: () => userApi.checkin.exchange(Math.round((Number(exchangePoints) || 0) * 100) / 100),
    onSuccess: (result) => {
      toast.success(
        zh
          ? `已兑换 ${formatPts(result.points_spent)} 积分 → ${formatCredits(result.balance_credited_micros)} 余额`
          : `Exchanged ${formatPts(result.points_spent)} points → ${formatCredits(result.balance_credited_micros)} balance`,
      );
      qc.setQueryData(["user", "checkin"], result.status);
      qc.invalidateQueries({ queryKey: ["user", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["user", "me"] });
      qc.invalidateQueries({ queryKey: ["user", "commerce"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const canCheckin = Boolean(
    data?.can_checkin
    ?? (settings?.enabled && !data?.checked_in_today && !data?.at_balance_cap),
  );
  const canExchange =
    Boolean(settings && settings.exchange_rate > 0)
    && exchangePreview.points > 0
    && (points?.balance || 0) >= exchangePreview.points;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "每日签到" : "Daily check-in"}
        description={zh ? "签到领取随机积分，积分可兑换账户余额。" : "Check in daily for random points, then exchange them for wallet balance."}
      />

      <section className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Coins className="size-4 text-muted-foreground" />
              {zh ? "当前积分" : "Points balance"}
            </CardTitle>
            <CardDescription>{zh ? "可用于兑换余额" : "Available to exchange"}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-3xl font-medium tabular-nums">{formatPts(points?.balance)}</p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {zh
                ? `累计获得 ${formatPts(points?.lifetime_earned)} · 已兑换 ${formatPts(points?.lifetime_spent)}`
                : `Earned ${formatPts(points?.lifetime_earned)} · Spent ${formatPts(points?.lifetime_spent)}`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Gift className="size-4 text-muted-foreground" />
              {zh ? "今日签到" : "Today"}
            </CardTitle>
            <CardDescription>{data?.today || "—"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              {data?.checked_in_today ? (
                <Badge variant="success">{zh ? "已签到" : "Checked in"}</Badge>
              ) : data?.at_balance_cap ? (
                <Badge variant="destructive">{zh ? "已达上限" : "At cap"}</Badge>
              ) : settings?.enabled ? (
                <Badge variant="secondary">{zh ? "未签到" : "Not yet"}</Badge>
              ) : (
                <Badge variant="outline">{zh ? "功能关闭" : "Disabled"}</Badge>
              )}
              {data?.today_points != null ? (
                <span className="text-xs text-muted-foreground">
                  {zh ? `今日 +${formatPts(data.today_points)} 积分` : `Today +${formatPts(data.today_points)}`}
                </span>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {!settings?.enabled
                ? (zh ? "管理员已关闭签到。" : "Check-in is disabled by admin.")
                : data?.at_balance_cap
                  ? (zh
                      ? `积分以及积分兑换成余额的持有已达上限（${formatPts(settings.balance_cap)}）。请将积分兑换成余额并使用掉后再进行签到。`
                      : `Points + unspent check-in balance reached the hold cap (${formatPts(settings.balance_cap)}). Spend that wallet balance, then check in again.`)
                  : (zh
                      ? `每次随机 ${formatPts(settings.points_min)}–${formatPts(settings.points_max)} 积分${settings.balance_cap > 0 ? ` · 持有上限 ${formatPts(settings.balance_cap)}` : ""}`
                      : `Random ${formatPts(settings.points_min)}–${formatPts(settings.points_max)} points${settings.balance_cap > 0 ? ` · hold cap ${formatPts(settings.balance_cap)}` : ""}`)}
            </p>
            <Button
              className="w-full"
              disabled={!canCheckin || checkin.isPending || status.isLoading}
              onClick={() => checkin.mutate()}
            >
              <CalendarCheck2 data-icon="inline-start" />
              {checkin.isPending
                ? (zh ? "签到中…" : "Checking in…")
                : data?.checked_in_today
                  ? (zh ? "今日已签到" : "Already checked in")
                  : data?.at_balance_cap
                    ? (zh ? "持有已达上限" : "Hold cap reached")
                    : (zh ? "立即签到" : "Check in now")}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{zh ? "兑换余额" : "Exchange to balance"}</CardTitle>
            <CardDescription>
              {zh
                ? `当前比例：1 积分 = ${settings?.exchange_rate ?? 0} 余额`
                : `Rate: 1 point = ${settings?.exchange_rate ?? 0} balance`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>{zh ? "兑换积分" : "Points to exchange"}</Label>
              <Input
                type="number"
                min={0.01}
                step={0.01}
                value={exchangePoints}
                onChange={(event) => setExchangePoints(event.target.value)}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {zh
                ? `预计到账 ${exchangePreview.credits.toLocaleString(undefined, { maximumFractionDigits: 6 })} 余额 · 钱包 ${formatCredits(data?.wallet?.balance_micros || 0)}`
                : `≈ ${exchangePreview.credits.toLocaleString(undefined, { maximumFractionDigits: 6 })} balance · wallet ${formatCredits(data?.wallet?.balance_micros || 0)}`}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!points?.balance}
                onClick={() => setExchangePoints(formatPts(points?.balance || 0))}
              >
                {zh ? "全部" : "All"}
              </Button>
              <Button
                className="flex-1"
                disabled={!canExchange || exchange.isPending}
                onClick={() => exchange.mutate()}
              >
                {exchange.isPending ? (zh ? "兑换中…" : "Exchanging…") : (zh ? "兑换" : "Exchange")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-sm">{zh ? "最近签到" : "Recent check-ins"}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!data?.recent_checkins?.length ? (
              <EmptyState>{status.isLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无签到记录" : "No check-ins yet")}</EmptyState>
            ) : (
              <div className="divide-y divide-border/45">
                {data.recent_checkins.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                    <span className="font-mono text-muted-foreground">{row.checkin_date}</span>
                    <span className="font-mono tabular-nums text-foreground">+{formatPts(row.points)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-sm">{zh ? "积分流水" : "Points ledger"}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!data?.recent_ledger?.length ? (
              <EmptyState>{status.isLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无积分流水" : "No points activity")}</EmptyState>
            ) : (
              <div className="divide-y divide-border/45">
                {data.recent_ledger.map((row) => (
                  <div key={row.id} className="grid gap-1 px-4 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_80px_90px]">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{row.description || ledgerLabel(row.type, zh)}</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">{ledgerLabel(row.type, zh)} · {new Date(row.created_at).toLocaleString()}</p>
                    </div>
                    <p className={`font-mono tabular-nums sm:text-right ${row.amount >= 0 ? "text-foreground" : "text-destructive"}`}>
                      {row.amount > 0 ? `+${formatPts(row.amount)}` : formatPts(row.amount)}
                    </p>
                    <p className="font-mono tabular-nums text-muted-foreground sm:text-right">{formatPts(row.balance_after)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function ledgerLabel(type: string, zh: boolean) {
  const map: Record<string, string> = zh
    ? { checkin: "签到奖励", exchange: "兑换余额", adjustment: "调整" }
    : { checkin: "Check-in", exchange: "Exchange", adjustment: "Adjustment" };
  return map[type] || type;
}

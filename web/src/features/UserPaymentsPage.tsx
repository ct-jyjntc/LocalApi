import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, RefreshCw, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { userApi } from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCredits } from "@/lib/utils";

export function UserPaymentsPage() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["user-payment-config"], queryFn: userApi.payments.config });
  const orders = useQuery({
    queryKey: ["user-payment-orders"],
    queryFn: () => userApi.payments.orders(200),
    refetchInterval: (query) => query.state.data?.items.some((item) => ["pending", "paid"].includes(item.status)) ? 3_000 : false,
  });
  const me = useQuery({ queryKey: ["user-me"], queryFn: userApi.me });
  const [amount, setAmount] = useState("10");
  const returnedOrderNo = useRef<string | null>(null);
  const channel = config.data?.channel;

  const create = useMutation({
    mutationFn: () => userApi.payments.createTopup(amount),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ["user-payment-orders"] });
      qc.invalidateQueries({ queryKey: ["user", "commerce-orders"] });
      if (order.pay_url) window.location.assign(order.pay_url);
      else toast.error("支付地址未生成，请稍后在订单中重新查询");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  useEffect(() => {
    const orderNo = new URLSearchParams(window.location.search).get("order_no");
    if (!orderNo) return;
    returnedOrderNo.current = orderNo;
    window.history.replaceState(null, "", "/payments");
    toast.info("支付页面已返回，正在等待到账通知");
    orders.refetch();
  }, [orders]);

  useEffect(() => {
    const orderNo = returnedOrderNo.current;
    if (!orderNo) return;
    const order = orders.data?.items.find((item) => item.order_no === orderNo);
    if (!order || !["credited", "refunded"].includes(order.status)) return;
    returnedOrderNo.current = null;
    toast.success(order.status === "credited" ? "支付已确认并入账" : "订单已退款");
    qc.invalidateQueries({ queryKey: ["user-me"] });
    qc.invalidateQueries({ queryKey: ["user-dashboard"] });
  }, [orders.data?.items, qc]);

  const amountMinor = Math.round((Number(amount) || 0) * 100);
  const credited = useMemo(() => {
    if (!channel || amountMinor <= 0) return 0;
    const fee = Math.min(amountMinor, Math.ceil(amountMinor * channel.fee_bps / 10_000) + channel.fee_fixed_minor);
    return ((amountMinor - fee) * channel.exchange_rate_micros) / 100 / 1_000_000;
  }, [amountMinor, channel]);
  const validAmount = Boolean(
    channel?.enabled && amountMinor >= channel.min_amount_minor && amountMinor <= channel.max_amount_minor,
  );

  return (
    <div className="space-y-6">
      <PageHeader title="账户充值" description="使用 LINUX DO Credit 为账户余额充值；订单记录统一在“账单与订单”中查看。" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,.85fr)]">
        <Card className="space-y-5 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">账户充值</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">支付完成后由回调自动入账，通常数秒内到账。</p>
            </div>
            <Badge variant={channel?.enabled ? "default" : "secondary"}>{channel?.enabled ? "渠道可用" : "暂不可用"}</Badge>
          </div>

          <div className="space-y-2">
            <Label>充值金额 / LDC</Label>
            <div className="relative">
              <Input type="number" min={channel ? channel.min_amount_minor / 100 : 0.01} max={channel ? channel.max_amount_minor / 100 : undefined} step="0.01" className="h-12 pr-14 font-mono text-lg tabular-nums" value={amount} onChange={(event) => setAmount(event.target.value)} />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">LDC</span>
            </div>
            {channel ? <p className="text-[11px] text-muted-foreground">单笔 {formatMinor(channel.min_amount_minor)}–{formatMinor(channel.max_amount_minor)} LDC</p> : null}
          </div>

          <div className="grid grid-cols-4 gap-2">
            {[10, 50, 100, 500].map((value) => (
              <Button key={value} type="button" variant={Number(amount) === value ? "default" : "secondary"} size="sm" className="font-mono tabular-nums" onClick={() => setAmount(String(value))}>{value}</Button>
            ))}
          </div>

          <div className="rounded-md bg-secondary/45 p-3">
            <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">预计到账额度</span><span className="font-mono text-base font-medium tabular-nums">{credited.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}</span></div>
            {channel ? <p className="mt-1 text-[10px] text-muted-foreground">兑换比例：1 LDC = {(channel.exchange_rate_micros / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 账户额度</p> : null}
          </div>

          <Button className="w-full" disabled={!validAmount || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <RefreshCw className="animate-spin" /> : <WalletCards />}{create.isPending ? "正在准备支付，请稍候" : "前往 LINUX DO Credit 支付"}<ArrowUpRight />
          </Button>
          {create.error ? <p className="rounded-md bg-destructive/8 px-3 py-2 text-center text-[11px] text-destructive">{create.error.message}</p> : null}
          {!channel?.enabled ? <p className="text-center text-[11px] text-muted-foreground">管理员尚未完成支付渠道配置。</p> : null}
        </Card>

        <Card className="flex flex-col justify-between gap-5 p-4 sm:p-5">
          <div>
            <p className="text-xs text-muted-foreground">当前账户余额</p>
            <p className="mt-3 break-all font-mono text-3xl font-medium tabular-nums tracking-tight">{formatCredits(me.data?.wallet?.balance_micros || 0)}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">可用于所有已定价模型的余额消费</p>
          </div>
          <div className="space-y-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
            <p>支付由 LINUX DO Credit 完成，本系统不会接触你的支付账户凭据。</p>
            <p>重复回调与重复查单均采用幂等处理，不会重复增加余额。</p>
            <p>目前退款仅支持管理员发起全额退款。</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function formatMinor(minor: number) {
  return (minor / 100).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

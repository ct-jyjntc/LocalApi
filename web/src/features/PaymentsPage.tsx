import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Copy, Pencil, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type PaymentOrder } from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppDialog } from "@/components/app-dialog-context";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const STATUS_LABEL: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  credited: "已入账",
  failed: "失败",
  expired: "已过期",
  cancelled: "已取消",
  refunding: "退款中",
  refunded: "已退款",
};

export function PaymentsPage() {
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const channel = useQuery({ queryKey: ["payment-channel"], queryFn: api.commercial.payments.channel });
  const channels = useQuery({ queryKey: ["payment-channels"], queryFn: api.commercial.payments.channels });
  const orders = useQuery({
    queryKey: ["payment-orders"],
    queryFn: () => api.commercial.payments.orders(undefined, 300),
    refetchInterval: 30_000,
  });
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState("LINUX DO Credit");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("https://credit.linux.do/epay");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [minAmount, setMinAmount] = useState("1");
  const [maxAmount, setMaxAmount] = useState("1000");
  const [alipayEnabled, setAlipayEnabled] = useState(false);
  const [alipayName, setAlipayName] = useState("支付宝");
  const [alipayAppId, setAlipayAppId] = useState("");
  const [alipayPrivateKey, setAlipayPrivateKey] = useState("");
  const [alipayPublicKey, setAlipayPublicKey] = useState("");
  const [alipaySellerId, setAlipaySellerId] = useState("");
  const [alipayGateway, setAlipayGateway] = useState("https://openapi.alipay.com/gateway.do");
  const [alipayExchangeRate, setAlipayExchangeRate] = useState("1");
  const [alipayMinAmount, setAlipayMinAmount] = useState("1");
  const [alipayMaxAmount, setAlipayMaxAmount] = useState("1000");
  const [alipayWebEnabled, setAlipayWebEnabled] = useState(true);
  const [alipayWapEnabled, setAlipayWapEnabled] = useState(true);
  const [linuxDoOpen, setLinuxDoOpen] = useState(false);
  const [alipayOpen, setAlipayOpen] = useState(false);

  useEffect(() => {
    if (!channel.data) return;
    setEnabled(channel.data.enabled);
    setName(channel.data.name);
    setClientId(channel.data.client_id || "");
    setClientSecret(channel.data.client_secret || "");
    setGatewayUrl(channel.data.gateway_url || "https://credit.linux.do/epay");
    setExchangeRate(String(channel.data.exchange_rate_micros / 1_000_000));
    setMinAmount((channel.data.min_amount_minor / 100).toFixed(2).replace(/\.00$/, ""));
    setMaxAmount((channel.data.max_amount_minor / 100).toFixed(2).replace(/\.00$/, ""));
  }, [channel.data]);

  useEffect(() => {
    const alipay = channels.data?.items.find((item) => item.id === "alipay");
    if (!alipay) return;
    setAlipayEnabled(alipay.enabled);
    setAlipayName(alipay.name);
    setAlipayAppId(alipay.client_id || "");
    setAlipayPrivateKey(alipay.client_secret || "");
    setAlipayPublicKey(alipay.alipay_public_key || "");
    setAlipaySellerId(alipay.seller_id || "");
    setAlipayGateway(alipay.gateway_url || "https://openapi.alipay.com/gateway.do");
    setAlipayExchangeRate(String(alipay.exchange_rate_micros / 1_000_000));
    setAlipayMinAmount((alipay.min_amount_minor / 100).toFixed(2).replace(/\.00$/, ""));
    setAlipayMaxAmount((alipay.max_amount_minor / 100).toFixed(2).replace(/\.00$/, ""));
    setAlipayWebEnabled(alipay.web_enabled !== false);
    setAlipayWapEnabled(alipay.wap_enabled !== false);
  }, [channels.data]);

  const save = useMutation({
    mutationFn: () => api.commercial.payments.updateChannel({
      enabled,
      name: name.trim(),
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      gateway_url: gatewayUrl.trim(),
      exchange_rate_micros: Math.max(1, Math.round(Number(exchangeRate) * 1_000_000)),
      min_amount_minor: Math.max(1, Math.round(Number(minAmount) * 100)),
      max_amount_minor: Math.max(1, Math.round(Number(maxAmount) * 100)),
    }),
    onSuccess: () => {
      toast.success("支付渠道已保存");
      qc.invalidateQueries({ queryKey: ["payment-channel"] });
      qc.invalidateQueries({ queryKey: ["payment-channels"] });
      setLinuxDoOpen(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const saveAlipay = useMutation({
    mutationFn: () => api.commercial.payments.updateChannelById("alipay", {
      enabled: alipayEnabled,
      name: alipayName.trim(),
      client_id: alipayAppId.trim(),
      client_secret: alipayPrivateKey.trim(),
      alipay_public_key: alipayPublicKey.trim(),
      seller_id: alipaySellerId.trim(),
      gateway_url: alipayGateway.trim(),
      exchange_rate_micros: Math.max(1, Math.round(Number(alipayExchangeRate) * 1_000_000)),
      min_amount_minor: Math.max(1, Math.round(Number(alipayMinAmount) * 100)),
      max_amount_minor: Math.max(1, Math.round(Number(alipayMaxAmount) * 100)),
      web_enabled: alipayWebEnabled,
      wap_enabled: alipayWapEnabled,
    }),
    onSuccess: () => {
      toast.success("支付宝渠道已保存");
      qc.invalidateQueries({ queryKey: ["payment-channels"] });
      setAlipayOpen(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const sync = useMutation({
    mutationFn: (id: string) => api.commercial.payments.sync(id),
    onSuccess: () => {
      toast.success("订单状态已同步");
      qc.invalidateQueries({ queryKey: ["payment-orders"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const refund = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.commercial.payments.refund(id, reason),
    onSuccess: () => {
      toast.success("退款已完成");
      qc.invalidateQueries({ queryKey: ["payment-orders"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const cancel = useMutation({
    mutationFn: api.commercial.payments.cancel,
    onSuccess: () => {
      toast.success("订单已取消");
      qc.invalidateQueries({ queryKey: ["payment-orders"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: api.commercial.payments.remove,
    onSuccess: () => {
      toast.success("订单已删除");
      qc.invalidateQueries({ queryKey: ["payment-orders"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const copy = async (value?: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    toast.success("已复制");
  };
  const requestRefund = async (order: PaymentOrder) => {
    const reason = await dialogs.prompt({ title: `退款 ${order.order_no}`, description: `确认全额退回 ${order.amount} ${order.asset}，并从用户余额扣回 ${formatCredits(order.credited_micros)}？`, label: "退款原因", placeholder: "请输入退款原因", confirmText: "确认退款", destructive: true, required: true });
    if (reason) refund.mutate({ id: order.id, reason });
  };
  const requestCancel = async (order: PaymentOrder) => { if (await dialogs.confirm({ title: "取消充值订单", description: `确认取消订单 ${order.order_no}？`, confirmText: "取消订单", destructive: true })) cancel.mutate(order.id); };
  const requestDelete = async (order: PaymentOrder) => { if (await dialogs.confirm({ title: "删除订单记录", description: `确认删除订单 ${order.order_no}？`, confirmText: "删除", destructive: true })) remove.mutate(order.id); };

  return (
    <div className="space-y-6">
      <PageHeader title="支付与订单" description="配置收款渠道、核对充值订单并处理全额退款。" />

      <div className="grid gap-3 md:grid-cols-2">
        <ChannelSummary name={name} description="EasyPay · LDC" enabled={enabled} rate={`1 LDC = ${exchangeRate} 额度`} range={`${minAmount}–${maxAmount} LDC`} onEdit={() => setLinuxDoOpen(true)} />
        <ChannelSummary name={alipayName} description="电脑网站支付 + 手机网站支付" enabled={alipayEnabled} rate={`1 CNY = ${alipayExchangeRate} 额度`} range={`${alipayMinAmount}–${alipayMaxAmount} CNY`} onEdit={() => setAlipayOpen(true)} />
      </div>

      <Dialog open={linuxDoOpen} onOpenChange={setLinuxDoOpen}><DialogContent className="max-w-[680px]"><DialogHeader><DialogTitle>编辑 LINUX DO Credit</DialogTitle><DialogDescription>配置商户凭据、兑换比例和充值范围。</DialogDescription></DialogHeader><div className="mt-4 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">LINUX DO Credit</h2>
              <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "已启用" : "未启用"}</Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">EasyPay 兼容协议 · MD5 签名 · 支持查单与全额退款</p>
          </div>
          <div className="flex items-center gap-2 rounded-md bg-secondary/55 px-3 py-2">
            <span className="text-xs text-muted-foreground">接受新订单</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="渠道名称"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="网关地址"><Input className="font-mono text-xs" value={gatewayUrl} onChange={(event) => setGatewayUrl(event.target.value)} /></Field>
          <Field label="Client ID / PID"><Input className="font-mono text-xs" value={clientId} onChange={(event) => setClientId(event.target.value)} /></Field>
          <Field label="Client Secret / Key"><Input className="font-mono text-xs" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} /></Field>
          <Field label="1 LDC 兑换账户额度"><Input type="number" min="0.000001" step="0.01" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="最低充值 / LDC"><Input type="number" min="0.01" step="0.01" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} /></Field>
            <Field label="最高充值 / LDC"><Input type="number" min="0.01" step="0.01" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} /></Field>
          </div>
        </div>

        <div className="grid gap-2 rounded-md bg-secondary/40 p-3 text-[11px] sm:grid-cols-2">
          <CallbackRow label="异步通知" value={channel.data?.notify_url || "请先在设置中填写公开域名"} onCopy={copy} />
          <CallbackRow label="支付返回" value={channel.data?.return_url || "请先在设置中填写公开域名"} onCopy={copy} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setLinuxDoOpen(false)}>取消</Button>
          <Button size="sm" disabled={save.isPending || !name.trim() || !gatewayUrl.trim()} onClick={() => save.mutate()}>
            <Save />{save.isPending ? "保存中" : "保存渠道"}
          </Button>
        </DialogFooter>
      </div></DialogContent></Dialog>

      <Dialog open={alipayOpen} onOpenChange={setAlipayOpen}><DialogContent className="max-w-[760px]"><DialogHeader><DialogTitle>编辑支付宝</DialogTitle><DialogDescription>配置 RSA2 凭据、支付模式、兑换比例和充值范围。</DialogDescription></DialogHeader><div className="mt-4 flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">支付宝</h2>
              <Badge variant={alipayEnabled ? "default" : "secondary"}>{alipayEnabled ? "已启用" : "未启用"}</Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">电脑网站支付 + 手机网站支付 · RSA2 · 支持异步通知、主动查单与全额退款</p>
          </div>
          <div className="flex items-center gap-2 rounded-md bg-secondary/55 px-3 py-2">
            <span className="text-xs text-muted-foreground">接受新订单</span>
            <Switch checked={alipayEnabled} onCheckedChange={setAlipayEnabled} aria-label="启用支付宝" />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="渠道名称"><Input value={alipayName} onChange={(event) => setAlipayName(event.target.value)} /></Field>
          <Field label="支付宝 APPID"><Input className="font-mono text-xs" value={alipayAppId} onChange={(event) => setAlipayAppId(event.target.value)} /></Field>
          <Field label="商户 PID / seller_id（建议填写）"><Input className="font-mono text-xs" value={alipaySellerId} onChange={(event) => setAlipaySellerId(event.target.value)} /></Field>
          <Field label="支付宝网关"><Input className="font-mono text-xs" value={alipayGateway} onChange={(event) => setAlipayGateway(event.target.value)} /></Field>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="应用私钥（明文编辑，加密保存）"><Textarea className="min-h-36 resize-y font-mono text-[11px] leading-5" spellCheck={false} value={alipayPrivateKey} onChange={(event) => setAlipayPrivateKey(event.target.value)} /></Field>
          <Field label="支付宝公钥"><Textarea className="min-h-36 resize-y font-mono text-[11px] leading-5" spellCheck={false} value={alipayPublicKey} onChange={(event) => setAlipayPublicKey(event.target.value)} /></Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="1 CNY 兑换账户额度"><Input type="number" min="0.000001" step="0.01" value={alipayExchangeRate} onChange={(event) => setAlipayExchangeRate(event.target.value)} /></Field>
          <Field label="最低充值 / CNY"><Input type="number" min="0.01" step="0.01" value={alipayMinAmount} onChange={(event) => setAlipayMinAmount(event.target.value)} /></Field>
          <Field label="最高充值 / CNY"><Input type="number" min="0.01" step="0.01" value={alipayMaxAmount} onChange={(event) => setAlipayMaxAmount(event.target.value)} /></Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <SwitchRow label="电脑网站支付" description="PC 浏览器跳转支付宝网页收银台" checked={alipayWebEnabled} onCheckedChange={setAlipayWebEnabled} />
          <SwitchRow label="手机网站支付" description="手机浏览器唤起支付宝 App 或 H5 收银台" checked={alipayWapEnabled} onCheckedChange={setAlipayWapEnabled} />
        </div>

        <div className="grid gap-2 rounded-md bg-secondary/40 p-3 text-[11px] sm:grid-cols-2">
          <CallbackRow label="异步通知" value={channels.data?.items.find((item) => item.id === "alipay")?.notify_url || "请先在设置中填写公开域名"} onCopy={copy} />
          <CallbackRow label="支付返回" value={channels.data?.items.find((item) => item.id === "alipay")?.return_url || "请先在设置中填写公开域名"} onCopy={copy} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setAlipayOpen(false)}>取消</Button>
          <Button size="sm" disabled={saveAlipay.isPending || !alipayName.trim() || !alipayGateway.trim()} onClick={() => saveAlipay.mutate()}>
            <Save data-icon="inline-start" />{saveAlipay.isPending ? "保存中" : "保存支付宝"}
          </Button>
        </DialogFooter>
      </div></DialogContent></Dialog>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <h2 className="text-sm font-medium">充值订单</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">回调会自动入账；待支付订单可手动查单补偿。</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => orders.refetch()} disabled={orders.isFetching}>
            <RefreshCw className={cn(orders.isFetching && "animate-spin")} />刷新
          </Button>
        </div>
        {!orders.data?.items.length ? (
          <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">暂无充值订单</div>
        ) : (
          <>
            <div className="hidden xl:block">
              <div className="grid grid-cols-[minmax(150px,1.4fr)_minmax(90px,.8fr)_minmax(90px,.8fr)_90px_100px_90px_190px] gap-3 border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
                <span>订单</span><span>用户</span><span>渠道</span><span>金额</span><span>入账额度</span><span>状态</span><span className="text-right">操作</span>
              </div>
              {orders.data.items.map((order) => (
                <div key={order.id} className="grid min-h-14 grid-cols-[minmax(150px,1.4fr)_minmax(90px,.8fr)_minmax(90px,.8fr)_90px_100px_90px_190px] items-center gap-3 border-b border-border/40 px-4 py-2 text-xs last:border-0">
                  <OrderIdentity order={order} />
                  <div className="min-w-0"><p className="truncate">{order.display_name || order.username}</p><p className="truncate text-[10px] text-muted-foreground">{order.username}</p></div>
                  <span className="truncate text-muted-foreground">{order.channel_name || order.channel_id}</span>
                  <span className="font-mono tabular-nums">{order.amount} {order.asset}</span>
                  <span className="font-mono tabular-nums">{formatCredits(order.credited_micros)}</span>
                  <StatusBadge status={order.status} />
                  <OrderActions order={order} sync={() => sync.mutate(order.id)} refund={() => requestRefund(order)} cancel={() => requestCancel(order)} remove={() => requestDelete(order)} busy={sync.isPending || refund.isPending || cancel.isPending || remove.isPending} />
                </div>
              ))}
            </div>
            <div className="divide-y divide-border/50 xl:hidden">
              {orders.data.items.map((order) => (
                <div key={order.id} className="space-y-3 p-4 text-xs">
                  <div className="flex items-start justify-between gap-3"><OrderIdentity order={order} /><StatusBadge status={order.status} /></div>
                  <div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/40 p-2.5">
                    <SmallStat label="用户" value={order.display_name || order.username || "-"} />
                    <SmallStat label="支付渠道" value={order.channel_name || order.channel_id} />
                    <SmallStat label="支付金额" value={`${order.amount} ${order.asset}`} mono />
                    <SmallStat label="入账额度" value={formatCredits(order.credited_micros)} mono />
                    <SmallStat label="创建时间" value={formatDate(order.created_at)} />
                  </div>
                  <OrderActions order={order} sync={() => sync.mutate(order.id)} refund={() => requestRefund(order)} cancel={() => requestCancel(order)} remove={() => requestDelete(order)} busy={sync.isPending || refund.isPending || cancel.isPending || remove.isPending} />
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5"><Label>{label}</Label>{children}</label>;
}

function ChannelSummary({ name, description, enabled, rate, range, onEdit }: { name: string; description: string; enabled: boolean; rate: string; range: string; onEdit: () => void }) {
  return <Card className="p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-medium">{name}</h2><Badge variant={enabled ? "success" : "secondary"}>{enabled ? "已启用" : "未启用"}</Badge></div><p className="mt-1 text-[11px] text-muted-foreground">{description}</p></div><Button variant="ghost" size="icon" className="size-7" onClick={onEdit} aria-label={`编辑 ${name}`}><Pencil /></Button></div><div className="mt-4 grid grid-cols-2 gap-2"><SmallStat label="兑换比例" value={rate} mono /><SmallStat label="充值范围" value={range} mono /></div></Card>;
}

function SwitchRow({ label, description, checked, onCheckedChange }: { label: string; description: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2"><div className="min-w-0"><p className="text-xs">{label}</p><p className="text-[11px] text-muted-foreground">{description}</p></div><Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} /></div>;
}

function CallbackRow({ label, value, onCopy }: { label: string; value: string; onCopy: (value: string) => void }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><div className="mt-1 flex items-center gap-1"><code className="min-w-0 flex-1 truncate text-foreground/80">{value}</code><Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={() => onCopy(value)}><Copy /></Button></div></div>;
}

function OrderIdentity({ order }: { order: PaymentOrder }) {
  return <div className="min-w-0"><p className="truncate font-mono text-[11px]">{order.order_no}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{formatDate(order.created_at)}</p>{order.error ? <p className="mt-0.5 truncate text-[10px] text-destructive" title={order.error}>{order.error}</p> : null}</div>;
}

function StatusBadge({ status }: { status: string }) {
  const successful = status === "credited";
  const dangerous = status === "failed" || status === "refunded";
  return <Badge variant={successful ? "default" : dangerous ? "destructive" : "secondary"}>{successful ? <Check /> : null}{STATUS_LABEL[status] || status}</Badge>;
}

function OrderActions({ order, sync, refund, cancel, remove, busy }: { order: PaymentOrder; sync: () => void; refund: () => void; cancel: () => void; remove: () => void; busy: boolean }) {
  return <div className="flex flex-wrap justify-end gap-1.5"><Button variant="secondary" size="sm" disabled={busy || !["pending", "paid"].includes(order.status)} onClick={sync}><RefreshCw />查单</Button>{order.status === "pending" ? <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}><Ban />取消</Button> : null}<Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy || order.status !== "credited"} onClick={refund}><RotateCcw />退款</Button>{["failed", "expired", "cancelled"].includes(order.status) ? <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={remove}><Trash2 />删除</Button> : null}</div>;
}

function SmallStat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><p className="text-[10px] text-muted-foreground">{label}</p><p className={cn("mt-0.5 truncate", mono && "font-mono tabular-nums")}>{value}</p></div>;
}

function formatCredits(micros: number) {
  return (micros / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { userApi } from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserSettingsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const me = useQuery({ queryKey: ["user", "me"], queryFn: userApi.me });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState({ current: "", next: "", confirm: "" });
  const changePassword = useMutation({
    mutationFn: () => userApi.changePassword(password.current, password.next),
    onSuccess: () => { setPasswordOpen(false); setPassword({ current: "", next: "", confirm: "" }); toast.success(zh ? "密码已修改" : "Password updated"); },
    onError: (error: Error) => toast.error(error.message),
  });
  const tier = me.data?.tier;
  const current = tier?.current;
  const next = tier?.next;
  const rangeStart = current?.threshold_micros || 0;
  const rangeEnd = next?.threshold_micros || rangeStart;
  const progress = next && rangeEnd > rangeStart ? Math.min(100, Math.max(0, ((tier!.lifetime_topup_micros - rangeStart) / (rangeEnd - rangeStart)) * 100)) : 100;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "个人设置" : "Personal settings"} description={zh ? "查看账户层级权益并维护登录密码。" : "Review account tier benefits and manage your password."} />
      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><UserRound className="size-4 text-muted-foreground" />{me.data?.user.display_name || "—"}</CardTitle><CardDescription>@{me.data?.user.username || "—"}</CardDescription></div><Badge variant={me.data?.user.status === "active" ? "success" : "secondary"}>{me.data?.user.status || "—"}</Badge></div></CardHeader><CardContent className="flex flex-col gap-3"><div className="grid grid-cols-2 gap-2"><Stat label={zh ? "账户余额" : "Balance"} value={formatCredits(me.data?.wallet?.balance_micros)} /><Stat label={zh ? "累计净充值" : "Lifetime top-up"} value={formatCredits(tier?.lifetime_topup_micros)} /></div><Button variant="secondary" size="sm" className="self-start" onClick={() => setPasswordOpen(true)}><KeyRound data-icon="inline-start" />{zh ? "修改密码" : "Change password"}</Button></CardContent></Card>
        <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-muted-foreground" />{current?.name || (zh ? "未匹配层级" : "No tier")}</CardTitle><CardDescription>{current?.description || (zh ? "余额模式调用权益" : "Wallet usage benefits")}</CardDescription></div><Badge>{zh ? "余额调用" : "Wallet"}</Badge></div></CardHeader><CardContent className="flex flex-col gap-3"><div className="grid grid-cols-3 gap-2"><Stat label="RPM" value={String(current?.rpm_limit || "∞")} /><Stat label="TPM" value={String(current?.tpm_limit || "∞")} /><Stat label={zh ? "并发" : "Concurrency"} value={String(current?.concurrency_limit || "∞")} /></div>{next ? <div className="flex flex-col gap-2 rounded-md bg-secondary/45 p-3"><div className="flex items-center justify-between gap-3 text-[11px]"><span className="text-muted-foreground">{zh ? `距离 ${next.name}` : `Until ${next.name}`}</span><span className="font-mono tabular-nums">{formatCredits(tier?.next_required_micros)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-background"><div className="h-full rounded-full bg-foreground/70" style={{ width: `${progress}%` }} /></div></div> : <p className="rounded-md bg-secondary/45 px-3 py-2 text-[11px] text-muted-foreground">{zh ? "已达到当前最高用户层级。" : "You have reached the highest tier."}</p>}<p className="text-[11px] leading-5 text-muted-foreground">{zh ? "用户层级仅影响直接使用余额的调用；/coding 请求始终使用 Coding Plan 的独立模型与调用限制。" : "Tiers only affect wallet calls. /coding uses separate plan limits."}</p></CardContent></Card>
      </div>

      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{zh ? "修改密码" : "Change password"}</DialogTitle><DialogDescription>{zh ? "需要验证当前密码，新密码至少 8 位。" : "Verify your current password and enter a new one."}</DialogDescription></DialogHeader>
          <form className="mt-4 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (password.next === password.confirm) changePassword.mutate(); }}>
            <Field label={zh ? "当前密码" : "Current password"}><Input type="password" autoFocus value={password.current} onChange={(event) => setPassword({ ...password, current: event.target.value })} /></Field>
            <Field label={zh ? "新密码" : "New password"}><Input type="password" value={password.next} onChange={(event) => setPassword({ ...password, next: event.target.value })} /></Field>
            <Field label={zh ? "确认新密码" : "Confirm password"}><Input type="password" aria-invalid={Boolean(password.confirm && password.next !== password.confirm)} value={password.confirm} onChange={(event) => setPassword({ ...password, confirm: event.target.value })} /></Field>
            {password.confirm && password.next !== password.confirm ? <p className="text-xs text-destructive">{zh ? "两次输入的新密码不一致" : "Passwords do not match"}</p> : null}
            <DialogFooter className="mt-1"><Button type="button" variant="secondary" onClick={() => setPasswordOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button type="submit" disabled={changePassword.isPending || password.current.length < 8 || password.next.length < 8 || password.next !== password.confirm}>{changePassword.isPending ? (zh ? "保存中…" : "Saving…") : (zh ? "保存密码" : "Save password")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="flex flex-col gap-1.5"><Label>{label}</Label>{children}</label>; }
function Stat({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-md bg-secondary/45 p-2.5"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono text-xs tabular-nums">{value}</p></div>; }

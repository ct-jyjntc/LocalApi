import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Gauge,
  Info,
  KeyRound,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { userApi } from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

function formatLimit(value: number | null | undefined) {
  if (value == null || value === 0) return "∞";
  return value.toLocaleString();
}

function passwordStrength(password: string, zh: boolean) {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (!password) {
    return { score: 0, label: zh ? "未输入" : "Empty", tone: "bg-border" };
  }
  if (score <= 2) return { score, label: zh ? "较弱" : "Weak", tone: "bg-destructive/80" };
  if (score <= 3) return { score, label: zh ? "一般" : "Fair", tone: "bg-amber-500" };
  return { score, label: zh ? "较强" : "Strong", tone: "bg-emerald-500" };
}

export function UserSettingsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const me = useQuery({ queryKey: ["user", "me"], queryFn: userApi.me });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState({ current: "", next: "", confirm: "" });

  const changePassword = useMutation({
    mutationFn: () => userApi.changePassword(password.current, password.next),
    onSuccess: () => {
      setPasswordOpen(false);
      setPassword({ current: "", next: "", confirm: "" });
      toast.success(zh ? "密码已修改" : "Password updated");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const user = me.data?.user;
  const wallet = me.data?.wallet;
  const tier = me.data?.tier;
  const current = tier?.current;
  const next = tier?.next;
  const rangeStart = current?.threshold_micros || 0;
  const rangeEnd = next?.threshold_micros || rangeStart;
  const progress =
    next && rangeEnd > rangeStart
      ? Math.min(
          100,
          Math.max(0, ((tier!.lifetime_topup_micros - rangeStart) / (rangeEnd - rangeStart)) * 100),
        )
      : 100;
  const strength = useMemo(() => passwordStrength(password.next, zh), [password.next, zh]);
  const initials = (user?.display_name || user?.username || "?").trim().slice(0, 1).toUpperCase();
  const statusActive = user?.status === "active";
  const canSubmitPassword =
    password.current.length >= 8 &&
    password.next.length >= 8 &&
    password.next === password.confirm &&
    !changePassword.isPending;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "个人设置" : "Personal settings"}
        description={
          zh
            ? "管理账户资料、安全设置与余额调用层级权益。"
            : "Manage profile, security, and wallet-tier benefits."
        }
      />

      {/* Profile hero */}
      <Card className="overflow-hidden border-border/60">
        <div className="border-b border-border/50 bg-gradient-to-br from-secondary/70 via-secondary/30 to-transparent px-4 py-5 sm:px-6 sm:py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-foreground text-base font-semibold text-background shadow-sm">
                {initials}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-lg font-medium tracking-tight">
                    {user?.display_name || "—"}
                  </h2>
                  <Badge variant={statusActive ? "success" : "secondary"} className="capitalize">
                    {user?.status || "—"}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">@{user?.username || "—"}</p>
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                  {zh
                    ? "资料用于控制台展示；API 调用以密钥与套餐权限为准。"
                    : "Profile is for console display. API access is controlled by keys and plans."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPasswordOpen(true)}>
                <KeyRound data-icon="inline-start" />
                {zh ? "修改密码" : "Change password"}
              </Button>
            </div>
          </div>
        </div>

        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
          <Metric
            icon={<Wallet className="size-3.5" />}
            label={zh ? "账户余额" : "Balance"}
            value={formatCredits(wallet?.balance_micros)}
            hint={
              zh
                ? `冻结 ${formatCredits(wallet?.reserved_micros)}`
                : `Reserved ${formatCredits(wallet?.reserved_micros)}`
            }
          />
          <Metric
            icon={<Sparkles className="size-3.5" />}
            label={zh ? "累计净充值" : "Lifetime top-up"}
            value={formatCredits(tier?.lifetime_topup_micros)}
            hint={zh ? "决定用户层级" : "Determines tier"}
          />
          <Metric
            icon={<ShieldCheck className="size-3.5" />}
            label={zh ? "当前层级" : "Current tier"}
            value={current?.name || (zh ? "未匹配" : "None")}
            hint={current?.description || (zh ? "余额模式权益" : "Wallet benefits")}
          />
          <Metric
            icon={<Gauge className="size-3.5" />}
            label={zh ? "下一层级" : "Next tier"}
            value={next?.name || (zh ? "已是最高" : "Max tier")}
            hint={
              next
                ? zh
                  ? `还需 ${formatCredits(tier?.next_required_micros)}`
                  : `${formatCredits(tier?.next_required_micros)} to go`
                : zh
                  ? "无需继续升级"
                  : "No further upgrade"
            }
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        {/* Tier benefits */}
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="size-4 text-muted-foreground" />
                  {zh ? "层级权益" : "Tier benefits"}
                </CardTitle>
                <CardDescription className="mt-1">
                  {zh
                    ? "仅作用于余额模式调用；Coding Plan 有独立额度与模型限制。"
                    : "Applies to wallet calls only. Coding Plan has separate limits."}
                </CardDescription>
              </div>
              <Badge variant="secondary">{zh ? "余额调用" : "Wallet"}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-3 gap-2">
              <LimitCard label="RPM" value={formatLimit(current?.rpm_limit)} />
              <LimitCard label="TPM" value={formatLimit(current?.tpm_limit)} />
              <LimitCard label={zh ? "并发" : "Concurrency"} value={formatLimit(current?.concurrency_limit)} />
            </div>

            {next ? (
              <div className="rounded-xl border border-border/60 bg-secondary/35 p-3.5">
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="text-muted-foreground">
                    {zh ? `升级进度 · ${next.name}` : `Progress · ${next.name}`}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {formatCredits(tier?.lifetime_topup_micros)} / {formatCredits(rangeEnd)}
                  </span>
                </div>
                <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-background/90">
                  <div
                    className="h-full rounded-full bg-foreground/80 transition-[width] duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                  {zh
                    ? `再累计净充值 ${formatCredits(tier?.next_required_micros)} 可进入 ${next.name}。`
                    : `${formatCredits(tier?.next_required_micros)} more net top-up unlocks ${next.name}.`}
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-secondary/35 px-3.5 py-3">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {zh ? "已达到当前最高用户层级" : "Highest tier reached"}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    {zh
                      ? "你当前享受余额模式下的最高调用权益。"
                      : "You already have the top wallet-mode benefits."}
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <p>
                {zh
                  ? "用户层级只影响直接使用余额的请求。/coding 请求始终走 Coding Plan 的独立模型与调用限制。"
                  : "Tiers only affect direct wallet requests. /coding always uses Coding Plan models and limits."}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Security */}
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4 text-muted-foreground" />
              {zh ? "安全与登录" : "Security & sign-in"}
            </CardTitle>
            <CardDescription className="mt-1">
              {zh ? "定期更新密码，保护控制台与 API 资产。" : "Keep your console and API assets secure."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="rounded-xl border border-border/60 bg-secondary/30 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium">{zh ? "登录密码" : "Login password"}</p>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    {zh
                      ? "用于网页控制台登录。修改后当前会话保持有效，其它设备需重新登录。"
                      : "Used for console login. Current session stays signed in; other devices must re-auth."}
                  </p>
                </div>
                <UserRound className="size-4 shrink-0 text-muted-foreground" />
              </div>
              <Button className="mt-3" size="sm" onClick={() => setPasswordOpen(true)}>
                <KeyRound data-icon="inline-start" />
                {zh ? "修改密码" : "Change password"}
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              <Tip
                title={zh ? "密码建议" : "Password tips"}
                body={
                  zh
                    ? "至少 8 位，建议包含大小写字母、数字与符号。"
                    : "Use 8+ characters with mixed case, numbers, and symbols."
                }
              />
              <Tip
                title={zh ? "密钥安全" : "Key safety"}
                body={
                  zh
                    ? "API Key 请在「API 密钥」页轮换；不要把密钥写进公开仓库。"
                    : "Rotate keys under API Keys. Never commit secrets to public repos."
                }
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={passwordOpen}
        onOpenChange={(open) => {
          setPasswordOpen(open);
          if (!open) setPassword({ current: "", next: "", confirm: "" });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{zh ? "修改密码" : "Change password"}</DialogTitle>
            <DialogDescription>
              {zh ? "需要验证当前密码，新密码至少 8 位。" : "Verify the current password. New password needs 8+ characters."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmitPassword) changePassword.mutate();
            }}
          >
            <Field label={zh ? "当前密码" : "Current password"}>
              <Input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password.current}
                onChange={(event) => setPassword({ ...password, current: event.target.value })}
              />
            </Field>
            <Field label={zh ? "新密码" : "New password"}>
              <Input
                type="password"
                autoComplete="new-password"
                value={password.next}
                onChange={(event) => setPassword({ ...password, next: event.target.value })}
              />
              <div className="mt-2 flex items-center gap-2">
                <div className="flex h-1.5 flex-1 gap-1">
                  {[0, 1, 2, 3].map((step) => (
                    <div
                      key={step}
                      className={cn(
                        "h-full flex-1 rounded-full bg-border/80 transition-colors",
                        strength.score > step && strength.tone,
                      )}
                    />
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">{strength.label}</span>
              </div>
            </Field>
            <Field label={zh ? "确认新密码" : "Confirm password"}>
              <Input
                type="password"
                autoComplete="new-password"
                aria-invalid={Boolean(password.confirm && password.next !== password.confirm)}
                value={password.confirm}
                onChange={(event) => setPassword({ ...password, confirm: event.target.value })}
              />
            </Field>
            {password.confirm && password.next !== password.confirm ? (
              <p className="text-xs text-destructive">
                {zh ? "两次输入的新密码不一致" : "Passwords do not match"}
              </p>
            ) : null}
            <DialogFooter className="mt-1">
              <Button type="button" variant="secondary" onClick={() => setPasswordOpen(false)}>
                {zh ? "取消" : "Cancel"}
              </Button>
              <Button type="submit" disabled={!canSubmitPassword}>
                {changePassword.isPending
                  ? zh
                    ? "保存中…"
                    : "Saving…"
                  : zh
                    ? "保存密码"
                    : "Save password"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/50 bg-secondary/30 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="text-muted-foreground/80">{icon}</span>
        <span>{label}</span>
      </div>
      <p className="mt-2 truncate font-mono text-sm font-medium tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function LimitCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/50 bg-secondary/35 px-3 py-3 text-center">
      <p className="text-[10px] tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 font-mono text-base font-medium tabular-nums">{value}</p>
    </div>
  );
}

function Tip({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-background/60 px-3 py-2.5">
      <p className="text-[11px] font-medium">{title}</p>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{body}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

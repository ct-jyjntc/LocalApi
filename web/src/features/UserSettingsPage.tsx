import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { userApi } from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

function formatLimit(value: number | null | undefined) {
  if (value == null || value === 0) return "∞";
  return value.toLocaleString();
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
  const initials = (user?.display_name || user?.username || "?").trim().slice(0, 1).toUpperCase();
  const canSubmitPassword =
    password.current.length >= 8 &&
    password.next.length >= 8 &&
    password.next === password.confirm &&
    !changePassword.isPending;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "个人设置" : "Personal settings"}
        description={zh ? "账户资料、余额层级与登录安全。" : "Profile, wallet tier, and sign-in security."}
      />

      <div className="grid gap-3 xl:grid-cols-[1.05fr_0.95fr]">
        {/* Account */}
        <Card className="flex flex-col gap-5 p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-medium">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-base font-medium tracking-tight">
                  {user?.display_name || "—"}
                </h2>
                <Badge variant={user?.status === "active" ? "success" : "secondary"}>
                  {user?.status || "—"}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                @{user?.username || "—"}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setPasswordOpen(true)}>
              <KeyRound data-icon="inline-start" />
              {zh ? "修改密码" : "Password"}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-secondary/45 px-3 py-3">
              <p className="text-[11px] text-muted-foreground">{zh ? "账户余额" : "Balance"}</p>
              <p className="mt-1.5 font-mono text-lg font-medium tabular-nums tracking-tight">
                {formatCredits(wallet?.balance_micros)}
              </p>
            </div>
            <div className="rounded-lg bg-secondary/45 px-3 py-3">
              <p className="text-[11px] text-muted-foreground">
                {zh ? "累计净充值" : "Lifetime top-up"}
              </p>
              <p className="mt-1.5 font-mono text-lg font-medium tabular-nums tracking-tight">
                {formatCredits(tier?.lifetime_topup_micros)}
              </p>
            </div>
          </div>
        </Card>

        {/* Tier */}
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground">{zh ? "余额调用层级" : "Wallet tier"}</p>
              <h2 className="mt-1 truncate text-base font-medium tracking-tight">
                {current?.name || (zh ? "未匹配层级" : "No tier")}
              </h2>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <SoftStat label="RPM" value={formatLimit(current?.rpm_limit)} />
            <SoftStat label="TPM" value={formatLimit(current?.tpm_limit)} />
            <SoftStat
              label={zh ? "并发" : "Concurrency"}
              value={formatLimit(current?.concurrency_limit)}
            />
          </div>

          {next ? (
            <div className="mt-auto">
              <div className="flex items-center justify-between gap-3 text-[11px]">
                <span className="text-muted-foreground">
                  {zh ? `下一档 ${next.name}` : `Next: ${next.name}`}
                </span>
                <span className="font-mono tabular-nums">
                  {formatCredits(tier?.next_required_micros)}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-foreground/75 transition-[width]"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="mt-auto text-[11px] text-muted-foreground">
              {zh ? "已是最高层级" : "Highest tier reached"}
            </p>
          )}
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
              {zh
                ? "需要验证当前密码，新密码至少 8 位。"
                : "Verify current password. New password needs 8+ characters."}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

function SoftStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-secondary/45 px-3 py-2.5 text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

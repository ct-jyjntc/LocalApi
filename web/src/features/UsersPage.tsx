import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Plus, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type PlanRow, type UserRow } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { useAppDialog } from "@/components/app-dialog-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { creditsToMicros, formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

function formatPoints(value: number | null | undefined) {
  return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function UsersPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const users = useQuery({ queryKey: ["commercial", "users"], queryFn: api.commercial.users.list });
  const plans = useQuery({ queryKey: ["commercial", "plans"], queryFn: api.commercial.plans.list });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ username: "", display_name: "", password: "" });
  const selected = useMemo(() => users.data?.items.find((user) => user.id === selectedId) ?? null, [selectedId, users.data?.items]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["commercial", "users"] });
  const create = useMutation({
    mutationFn: () => api.commercial.users.create(form),
    onSuccess: () => {
      setCreateOpen(false);
      setForm({ username: "", display_name: "", password: "" });
      toast.success(zh ? "用户已创建" : "User created");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: api.commercial.users.remove,
    onSuccess: () => {
      setSelectedId(null);
      toast.success(zh ? "用户已删除" : "User removed");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const requestDelete = async (user: UserRow) => {
    if (
      await dialogs.confirm({
        title: zh ? "删除用户" : "Delete user",
        description: zh
          ? `确认删除 ${user.display_name}（@${user.username}）？其 API Key、余额与历史关联数据将一并处理。`
          : `Delete ${user.display_name} (@${user.username})?`,
        confirmText: zh ? "删除" : "Delete",
        destructive: true,
      })
    ) {
      remove.mutate(user.id);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "用户" : "Users"}
        description={
          zh
            ? "查看并调整余额、套餐剩余额度与积分；余额调用与 Coding Plan 权益彼此独立。"
            : "View and adjust wallet balance, plan remaining credits, and points."
        }
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            {zh ? "创建用户" : "Create user"}
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {!users.data?.items.length ? (
          <EmptyState>{users.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无用户" : "No users"}</EmptyState>
        ) : (
          <>
            <div className="divide-y divide-border/40 sm:hidden">
              {users.data.items.map((user) => (
                <div className="flex flex-col gap-2.5 p-3 text-xs" key={user.id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate">
                      <span className="font-medium">{user.display_name}</span>
                      <span className="ml-1 text-[11px] text-muted-foreground">@{user.username}</span>
                    </p>
                    <Badge variant={user.status === "active" ? "success" : "destructive"}>{user.status}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 text-[11px]">
                    <Stat label={zh ? "余额" : "Balance"} value={formatCredits(user.balance_micros)} />
                    <Stat label={zh ? "积分" : "Points"} value={formatPoints(user.points_balance)} />
                    <Stat label={zh ? "套餐" : "Plan"} value={user.plan_name || "—"} />
                    <Stat
                      label={zh ? "套餐剩余" : "Plan left"}
                      value={user.plan_id ? formatCredits(user.remaining_credits_micros || 0) : "—"}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{user.last_login_at ? shortTime(user.last_login_at) : zh ? "尚未登录" : "Never signed in"}</span>
                    <Button variant="secondary" size="sm" onClick={() => setSelectedId(user.id)}>
                      <Settings2 data-icon="inline-start" />
                      {zh ? "管理" : "Manage"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden sm:block">
              <div className={TABLE_HEAD_CLASS}>
                <span className="w-40 shrink-0">{zh ? "用户" : "User"}</span>
                <span className="w-24 shrink-0">{zh ? "余额" : "Balance"}</span>
                <span className="w-20 shrink-0">{zh ? "积分" : "Points"}</span>
                <span className="min-w-0 flex-1">{zh ? "套餐 / 剩余" : "Plan / left"}</span>
                <span className="hidden w-32 shrink-0 lg:block">{zh ? "最近登录" : "Last login"}</span>
                <span className="w-16 shrink-0 text-right">{zh ? "操作" : "Actions"}</span>
              </div>
              {users.data.items.map((user) => (
                <div className={TABLE_ROW_CLASS} key={user.id}>
                  <span className="w-40 shrink-0 truncate">
                    <span className="font-medium">{user.display_name}</span>
                    <span className="ml-1 text-[11px] text-muted-foreground">@{user.username}</span>
                  </span>
                  <span className="w-24 shrink-0 font-mono tabular-nums">{formatCredits(user.balance_micros)}</span>
                  <span className="w-20 shrink-0 font-mono tabular-nums">{formatPoints(user.points_balance)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {user.plan_name ? (
                      <>
                        <span>{user.plan_name}</span>
                        <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                          {formatCredits(user.remaining_credits_micros || 0)}
                          {user.plan_included_credits_micros != null
                            ? ` / ${formatCredits(user.plan_included_credits_micros)}`
                            : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                  <span className="hidden w-32 shrink-0 text-[11px] text-muted-foreground lg:block">
                    {user.last_login_at ? shortTime(user.last_login_at) : "—"}
                  </span>
                  <span className="flex w-16 shrink-0 justify-end">
                    <Button variant="ghost" size="icon" className="size-6" onClick={() => setSelectedId(user.id)}>
                      <Settings2 />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{zh ? "创建用户" : "Create user"}</DialogTitle>
            <DialogDescription>{zh ? "创建后用户可以登录控制台并创建 API Key。" : "The user can sign in and create API keys."}</DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field label={zh ? "用户名" : "Username"}>
              <Input autoFocus value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
            </Field>
            <Field label={zh ? "显示名称" : "Display name"}>
              <Input value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />
            </Field>
            <Field label={zh ? "初始密码" : "Initial password"}>
              <Input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </Field>
            <DialogFooter className="mt-1">
              <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
                {zh ? "取消" : "Cancel"}
              </Button>
              <Button type="submit" disabled={create.isPending || form.username.trim().length < 2 || form.password.length < 8}>
                {create.isPending ? (zh ? "创建中…" : "Creating…") : zh ? "创建" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {selected ? (
        <UserManager
          user={selected}
          plans={plans.data?.items || []}
          zh={zh}
          open
          onRefresh={refresh}
          onClose={() => setSelectedId(null)}
          onDelete={() => requestDelete(selected)}
        />
      ) : null}
    </div>
  );
}

function UserManager({
  user,
  plans,
  zh,
  open,
  onRefresh,
  onClose,
  onDelete,
}: {
  user: UserRow;
  plans: PlanRow[];
  zh: boolean;
  open: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const dialogs = useAppDialog();
  const [credit, setCredit] = useState("0");
  const [description, setDescription] = useState(zh ? "管理员调账" : "Admin adjustment");
  const [planCredit, setPlanCredit] = useState("0");
  const [planCreditNote, setPlanCreditNote] = useState(zh ? "管理员调整套餐额度" : "Admin plan credit adjustment");
  const [pointsDelta, setPointsDelta] = useState("0");
  const [pointsNote, setPointsNote] = useState(zh ? "管理员调整积分" : "Admin points adjustment");
  const [planId, setPlanId] = useState(user.plan_id || "");
  const [account, setAccount] = useState({ display_name: user.display_name, status: user.status, password: "" });

  useEffect(() => {
    setPlanId(user.plan_id || "");
    setAccount({ display_name: user.display_name, status: user.status, password: "" });
  }, [user.id, user.plan_id, user.display_name, user.status]);

  const mutation = useMutation({
    mutationFn: async (
      action: "wallet" | "plan" | "cancel" | "save" | "planCredits" | "points",
    ) => {
      if (action === "wallet") return api.commercial.users.adjustWallet(user.id, creditsToMicros(credit), description);
      if (action === "plan") return api.commercial.users.assignPlan(user.id, planId);
      if (action === "cancel") return api.commercial.users.cancelPlan(user.id);
      if (action === "planCredits") {
        return api.commercial.users.adjustPlanCredits(user.id, creditsToMicros(planCredit), planCreditNote);
      }
      if (action === "points") {
        return api.commercial.users.adjustPoints(user.id, Number(pointsDelta) || 0, pointsNote);
      }
      return api.commercial.users.update(user.id, {
        display_name: account.display_name,
        status: account.status,
        ...(account.password ? { password: account.password } : {}),
      });
    },
    onSuccess: (_data, action) => {
      toast.success(
        action === "planCredits"
          ? zh
            ? "套餐剩余额度已更新"
            : "Plan remaining credits updated"
          : action === "points"
            ? zh
              ? "积分已更新"
              : "Points updated"
            : zh
              ? "用户配置已更新"
              : "User updated",
      );
      onRefresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const cancelPlan = async () => {
    if (
      await dialogs.confirm({
        title: zh ? "取消当前套餐" : "Cancel current plan",
        description: zh ? "套餐会立即失效，剩余额度不会退回。" : "The plan will end immediately and remaining quota will not be refunded.",
        confirmText: zh ? "取消套餐" : "Cancel plan",
        destructive: true,
      })
    ) {
      mutation.mutate("cancel");
    }
  };

  const planRemaining = user.remaining_credits_micros ?? 0;
  const planIncluded = user.plan_included_credits_micros ?? null;
  const planReserved = user.plan_reserved_micros ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-[860px]">
        <DialogHeader>
          <DialogTitle>{user.display_name}</DialogTitle>
          <DialogDescription>
            @{user.username} · {zh ? "累计净充值" : "Lifetime top-up"} {formatCredits(user.tier?.lifetime_topup_micros || 0)} ·{" "}
            {user.tier?.current?.name || "—"}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-secondary/40 p-3 text-[11px] sm:grid-cols-4">
          <Stat label={zh ? "账户余额" : "Wallet"} value={formatCredits(user.balance_micros)} />
          <Stat label={zh ? "积分" : "Points"} value={formatPoints(user.points_balance)} />
          <Stat label={zh ? "当前套餐" : "Plan"} value={user.plan_name || "—"} />
          <Stat
            label={zh ? "套餐剩余" : "Plan remaining"}
            value={user.plan_id ? formatCredits(planRemaining) : "—"}
          />
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <section className="flex min-w-0 flex-col gap-3 rounded-md bg-secondary/35 p-3">
            <h3 className="text-xs font-medium">{zh ? "账户" : "Account"}</h3>
            <Field label={zh ? "显示名称" : "Display name"}>
              <Input value={account.display_name} onChange={(event) => setAccount({ ...account, display_name: event.target.value })} />
            </Field>
            <Field label={zh ? "状态" : "Status"}>
              <select
                className="h-8 rounded-md border border-input bg-secondary/55 px-2.5 text-xs"
                value={account.status}
                onChange={(event) => setAccount({ ...account, status: event.target.value })}
              >
                <option value="active">active</option>
                <option value="suspended">suspended</option>
                <option value="disabled">disabled</option>
              </select>
            </Field>
            <Field label={zh ? "重置密码（可选）" : "Reset password (optional)"}>
              <Input type="password" value={account.password} onChange={(event) => setAccount({ ...account, password: event.target.value })} />
            </Field>
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate("save")}>
              {zh ? "保存账户" : "Save account"}
            </Button>
          </section>

          <section className="flex min-w-0 flex-col gap-3 rounded-md bg-secondary/35 p-3">
            <h3 className="text-xs font-medium">{zh ? "余额调整" : "Wallet adjustment"}</h3>
            <Field label={zh ? "额度（可填负数）" : "Credits (+/-)"}>
              <Input type="number" step="0.000001" value={credit} onChange={(event) => setCredit(event.target.value)} />
            </Field>
            <Field label={zh ? "备注" : "Description"}>
              <Input value={description} onChange={(event) => setDescription(event.target.value)} />
            </Field>
            <p className="text-[11px] leading-5 text-muted-foreground">
              {zh ? "管理员调账不会计入用户层级的累计充值。" : "Admin adjustments do not affect tier progress."}
            </p>
            <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate("wallet")}>
              {zh ? "调整余额" : "Adjust balance"}
            </Button>
          </section>

          <section className="flex min-w-0 flex-col gap-3 rounded-md bg-secondary/35 p-3">
            <h3 className="text-xs font-medium">{zh ? "积分调整" : "Points adjustment"}</h3>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <Stat label={zh ? "当前积分" : "Current"} value={formatPoints(user.points_balance)} />
              <Stat label={zh ? "累计获得" : "Earned"} value={formatPoints(user.points_lifetime_earned)} />
            </div>
            <Field label={zh ? "积分变动（可填负数）" : "Points delta (+/-)"}>
              <Input type="number" step="0.01" value={pointsDelta} onChange={(event) => setPointsDelta(event.target.value)} />
            </Field>
            <Field label={zh ? "备注" : "Description"}>
              <Input value={pointsNote} onChange={(event) => setPointsNote(event.target.value)} />
            </Field>
            <Button size="sm" disabled={mutation.isPending || !(Number(pointsDelta) || 0)} onClick={() => mutation.mutate("points")}>
              {zh ? "调整积分" : "Adjust points"}
            </Button>
          </section>

          <section className="flex min-w-0 flex-col gap-3 rounded-md bg-secondary/35 p-3">
            <h3 className="text-xs font-medium">Coding Plan</h3>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <Stat label={zh ? "套餐" : "Plan"} value={user.plan_name || "—"} />
              <Stat label={zh ? "剩余额度" : "Remaining"} value={user.plan_id ? formatCredits(planRemaining) : "—"} />
              <Stat label={zh ? "周期额度" : "Included"} value={planIncluded != null ? formatCredits(planIncluded) : "—"} />
              <Stat label={zh ? "冻结中" : "Reserved"} value={user.plan_id ? formatCredits(planReserved) : "—"} />
            </div>
            {user.period_end ? (
              <p className="text-[11px] text-muted-foreground">
                {zh ? "周期结束" : "Period ends"}: {shortTime(user.period_end)}
              </p>
            ) : null}

            <Field label={zh ? "剩余额度变动（可填负数）" : "Remaining credits delta (+/-)"}>
              <Input
                type="number"
                step="0.000001"
                value={planCredit}
                disabled={!user.plan_id}
                onChange={(event) => setPlanCredit(event.target.value)}
              />
            </Field>
            <Field label={zh ? "备注" : "Description"}>
              <Input value={planCreditNote} disabled={!user.plan_id} onChange={(event) => setPlanCreditNote(event.target.value)} />
            </Field>
            <Button
              size="sm"
              disabled={!user.plan_id || mutation.isPending || !(Number(planCredit) || 0)}
              onClick={() => mutation.mutate("planCredits")}
            >
              {zh ? "调整套餐剩余" : "Adjust plan remaining"}
            </Button>

            <div className="border-t border-border/50 pt-3">
              <Field label={zh ? "分配 / 更换套餐" : "Assign / replace plan"}>
                <select
                  className="h-8 rounded-md border border-input bg-secondary/55 px-2.5 text-xs"
                  value={planId}
                  onChange={(event) => setPlanId(event.target.value)}
                >
                  <option value="">—</option>
                  {plans
                    .filter((plan) => plan.enabled)
                    .map((plan) => (
                      <option key={plan.id} value={plan.id} disabled={plan.stock_available === 0 && plan.id !== user.plan_id}>
                        {plan.name}
                      </option>
                    ))}
                </select>
              </Field>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" disabled={!planId || mutation.isPending} onClick={() => mutation.mutate("plan")}>
                  {zh ? "分配并重置周期" : "Assign plan"}
                </Button>
                {user.plan_id ? (
                  <Button variant="secondary" size="sm" disabled={mutation.isPending} onClick={cancelPlan}>
                    {zh ? "取消当前套餐" : "Cancel current plan"}
                  </Button>
                ) : null}
              </div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                {zh
                  ? "分配套餐会重置周期并把剩余额度设为套餐包含额度。若只改剩余量，请用上方「调整套餐剩余」。"
                  : "Assigning a plan resets the cycle and remaining credits. Use the credit delta above to only change remaining quota."}
              </p>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="destructive" onClick={onDelete}>
            <Trash2 data-icon="inline-start" />
            {zh ? "删除用户" : "Delete user"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {zh ? "关闭" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono tabular-nums">{value}</p>
    </div>
  );
}

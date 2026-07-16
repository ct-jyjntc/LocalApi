import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Settings2, Trash2 } from "lucide-react";
import { api, type UserRow } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { creditsToMicros, formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UsersPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["commercial", "users"], queryFn: api.commercial.users.list });
  const plans = useQuery({ queryKey: ["commercial", "plans"], queryFn: api.commercial.plans.list });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", display_name: "", password: "" });

  const selected = useMemo(
    () => users.data?.items.find((user) => user.id === selectedId) ?? null,
    [selectedId, users.data?.items],
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ["commercial", "users"] });
  const create = useMutation({
    mutationFn: () => api.commercial.users.create(form),
    onSuccess: () => {
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "用户" : "Users"}
        description={zh ? "创建账号、分配余额与套餐，并控制模型和调用限制。" : "Create accounts, assign credit and plans, and control access limits."}
      />

      <Card>
        <CardHeader>
          <CardTitle>{zh ? "创建用户" : "Create user"}</CardTitle>
          <CardDescription>{zh ? "用户创建后可以登录自己的控制台并创建 API Key。" : "Users can sign in and create their own API keys."}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
          <Field label={zh ? "用户名" : "Username"}>
            <Input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </Field>
          <Field label={zh ? "显示名称" : "Display name"}>
            <Input value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />
          </Field>
          <Field label={zh ? "初始密码" : "Initial password"}>
            <Input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
          <Button
            size="sm"
            disabled={create.isPending || form.username.trim().length < 2 || form.password.length < 8}
            onClick={() => create.mutate()}
          >
            <Plus data-icon="inline-start" />
            {zh ? "创建" : "Create"}
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        {!users.data?.items.length ? (
          <EmptyState>{users.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无用户" : "No users"}</EmptyState>
        ) : (
          <>
            <div className="divide-y divide-border/40 sm:hidden">
              {users.data.items.map((user) => (
                <div className="space-y-2.5 p-3 text-xs" key={user.id}>
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <p className="min-w-0 truncate"><span className="font-medium">{user.display_name}</span><span className="ml-1 text-[11px] text-muted-foreground">@{user.username}</span></p>
                    <Badge variant={user.status === "active" ? "success" : "destructive"}>{user.status}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 text-[11px]">
                    <div><p className="text-muted-foreground">{zh ? "余额" : "Balance"}</p><p className="mt-1 font-mono tabular-nums">{formatCredits(user.balance_micros)}</p></div>
                    <div><p className="text-muted-foreground">{zh ? "套餐" : "Plan"}</p><p className="mt-1 truncate">{user.plan_name || "—"}{user.plan_name ? <span className="ml-1 font-mono text-muted-foreground">{formatCredits(user.remaining_credits_micros)}</span> : null}</p></div>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>{zh ? "最近登录" : "Last login"} {user.last_login_at ? shortTime(user.last_login_at) : "—"}</span><Button variant="secondary" size="sm" onClick={() => setSelectedId(user.id)}><Settings2 data-icon="inline-start" />{zh ? "管理" : "Manage"}</Button></div>
                </div>
              ))}
            </div>
            <div className="hidden sm:block">
              <div className={TABLE_HEAD_CLASS}><span className="w-40 shrink-0">{zh ? "用户" : "User"}</span><span className="w-28 shrink-0">{zh ? "余额" : "Balance"}</span><span className="min-w-0 flex-1">{zh ? "套餐" : "Plan"}</span><span className="hidden w-36 shrink-0 lg:block">{zh ? "最近登录" : "Last login"}</span><span className="w-24 shrink-0 text-right">{zh ? "操作" : "Actions"}</span></div>
              {users.data.items.map((user) => (
                <div className={TABLE_ROW_CLASS} key={user.id}><span className="w-40 shrink-0 truncate" title={user.username}><span className="font-medium">{user.display_name}</span><span className="ml-1 text-[11px] text-muted-foreground">@{user.username}</span></span><span className="w-28 shrink-0 font-mono tabular-nums">{formatCredits(user.balance_micros)}</span><span className="min-w-0 flex-1 truncate">{user.plan_name ? <><Badge variant="secondary">{user.plan_name}</Badge><span className="ml-2 text-[11px] text-muted-foreground">{formatCredits(user.remaining_credits_micros)}</span></> : <span className="text-muted-foreground">—</span>}</span><span className="hidden w-36 shrink-0 text-[11px] text-muted-foreground lg:block">{user.last_login_at ? shortTime(user.last_login_at) : "—"}</span><span className="flex w-24 shrink-0 justify-end gap-1"><Badge variant={user.status === "active" ? "success" : "destructive"}>{user.status}</Badge><Button variant="ghost" size="icon" className="size-6" onClick={() => setSelectedId(user.id)} aria-label="Manage"><Settings2 /></Button></span></div>
              ))}
            </div>
          </>
        )}
      </Card>

      {selected ? (
        <UserManager
          user={selected}
          plans={plans.data?.items ?? []}
          zh={zh}
          onRefresh={refresh}
          onDelete={() => remove.mutate(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function UserManager({ user, plans, zh, onRefresh, onDelete, onClose }: {
  user: UserRow;
  plans: Awaited<ReturnType<typeof api.commercial.plans.list>>["items"];
  zh: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [credit, setCredit] = useState("0");
  const [description, setDescription] = useState(zh ? "管理员调账" : "Admin adjustment");
  const [planId, setPlanId] = useState(user.plan_id || "");
  const [limits, setLimits] = useState({
    display_name: user.display_name,
    status: user.status,
    allowed_models: user.allowed_models.join("\n"),
    rpm_limit: String(user.rpm_limit || 0),
    tpm_limit: String(user.tpm_limit || 0),
    concurrency_limit: String(user.concurrency_limit || 0),
    password: "",
  });
  const mutation = useMutation({
    mutationFn: async (action: "wallet" | "plan" | "cancel" | "save") => {
      if (action === "wallet") return api.commercial.users.adjustWallet(user.id, creditsToMicros(credit), description);
      if (action === "plan") return api.commercial.users.assignPlan(user.id, planId);
      if (action === "cancel") return api.commercial.users.cancelPlan(user.id);
      return api.commercial.users.update(user.id, {
        display_name: limits.display_name,
        status: limits.status,
        allowed_models: limits.allowed_models.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean),
        rpm_limit: Number(limits.rpm_limit) || 0,
        tpm_limit: Number(limits.tpm_limit) || 0,
        concurrency_limit: Number(limits.concurrency_limit) || 0,
        ...(limits.password ? { password: limits.password } : {}),
      });
    },
    onSuccess: () => { toast.success(zh ? "用户配置已更新" : "User updated"); onRefresh(); },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div className="flex flex-col gap-1"><CardTitle>{user.display_name}</CardTitle><CardDescription>@{user.username}</CardDescription></div>
        <Button variant="secondary" size="sm" onClick={onClose}>{zh ? "收起" : "Close"}</Button>
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-3">
        <section className="min-w-0 flex flex-col gap-3 rounded-md bg-secondary/35 p-3">
          <h3 className="text-xs font-medium">{zh ? "余额调整" : "Wallet adjustment"}</h3>
          <Field label={zh ? "额度（可填负数）" : "Credits (negative allowed)"}><Input type="number" step="0.000001" value={credit} onChange={(e) => setCredit(e.target.value)} /></Field>
          <Field label={zh ? "备注" : "Description"}><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Button size="sm" onClick={() => mutation.mutate("wallet")}>{zh ? "调整余额" : "Adjust"}</Button>
        </section>
        <section className="min-w-0 flex flex-col gap-3 rounded-md bg-secondary/35 p-3">
          <h3 className="text-xs font-medium">{zh ? "套餐" : "Plan"}</h3>
          <Field label={zh ? "选择套餐" : "Select plan"}>
            <select className="h-8 w-full rounded-md border border-input bg-secondary/55 px-3 text-xs" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">—</option>{plans.filter((p) => p.enabled).map((plan) => <option key={plan.id} value={plan.id} disabled={plan.stock_available === 0 && plan.id !== user.plan_id}>{plan.name}{plan.stock_limit > 0 ? ` · ${zh ? "库存" : "Stock"} ${plan.stock_available ?? 0}` : ""}</option>)}
            </select>
          </Field>
          <Button size="sm" disabled={!planId} onClick={() => mutation.mutate("plan")}>{zh ? "分配并重置周期" : "Assign and reset"}</Button>
          <Button variant="secondary" size="sm" onClick={() => mutation.mutate("cancel")}>{zh ? "取消当前套餐" : "Cancel current plan"}</Button>
        </section>
        <section className="min-w-0 flex flex-col gap-3 rounded-md bg-secondary/35 p-3">
          <h3 className="text-xs font-medium">{zh ? "权限与限制" : "Access limits"}</h3>
          <Field label={zh ? "显示名称" : "Display name"}><Input value={limits.display_name} onChange={(e) => setLimits({ ...limits, display_name: e.target.value })} /></Field>
          <div className="grid min-w-0 gap-2 sm:grid-cols-3">
            <Field label="RPM"><Input type="number" value={limits.rpm_limit} onChange={(e) => setLimits({ ...limits, rpm_limit: e.target.value })} /></Field>
            <Field label="TPM"><Input type="number" value={limits.tpm_limit} onChange={(e) => setLimits({ ...limits, tpm_limit: e.target.value })} /></Field>
            <Field label={zh ? "并发" : "Concurrency"}><Input type="number" value={limits.concurrency_limit} onChange={(e) => setLimits({ ...limits, concurrency_limit: e.target.value })} /></Field>
          </div>
          <Field label={zh ? "允许模型（每行一个，空为全部）" : "Allowed models (one per line)"}><Textarea rows={3} value={limits.allowed_models} onChange={(e) => setLimits({ ...limits, allowed_models: e.target.value })} /></Field>
          <Field label={zh ? "重置密码（留空不变）" : "Reset password (blank keeps current)"}><Input type="password" value={limits.password} onChange={(e) => setLimits({ ...limits, password: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => mutation.mutate("save")}>{zh ? "保存" : "Save"}</Button>
            <Button variant="destructive" size="sm" onClick={() => { if (confirm(zh ? "确定删除该用户？" : "Delete this user?")) onDelete(); }}><Trash2 data-icon="inline-start" />{zh ? "删除" : "Delete"}</Button>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-1 flex-col gap-1.5"><Label>{label}</Label>{children}</label>;
}

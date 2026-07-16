import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, type PlanRow } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { creditsToMicros, formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type FormState = {
  id?: string;
  name: string;
  description: string;
  cycle: string;
  credits: string;
  models: string;
  rpm: string;
  tpm: string;
  concurrency: string;
  stock: string;
  overage: boolean;
  enabled: boolean;
};
const emptyForm: FormState = { name: "Coding Plan", description: "", cycle: "30", credits: "0", models: "", rpm: "0", tpm: "0", concurrency: "0", stock: "0", overage: true, enabled: true };

export function PlansPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["commercial", "plans"], queryFn: api.commercial.plans.list });
  const [form, setForm] = useState<FormState>(emptyForm);
  const body = () => ({
    name: form.name.trim(), description: form.description.trim(), cycle_days: Number(form.cycle) || 30,
    included_credits_micros: creditsToMicros(form.credits),
    allowed_models: form.models.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean),
    rpm_limit: Number(form.rpm) || 0, tpm_limit: Number(form.tpm) || 0,
    concurrency_limit: Number(form.concurrency) || 0, stock_limit: Math.max(0, Number(form.stock) || 0), overage_enabled: form.overage, enabled: form.enabled,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["commercial", "plans"] });
  const save = useMutation({
    mutationFn: () => form.id ? api.commercial.plans.update(form.id, body()) : api.commercial.plans.create(body()),
    onSuccess: () => { setForm(emptyForm); toast.success(zh ? "套餐已保存" : "Plan saved"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({ mutationFn: api.commercial.plans.remove, onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const edit = (plan: PlanRow) => setForm({ id: plan.id, name: plan.name, description: plan.description, cycle: String(plan.cycle_days), credits: formatCredits(plan.included_credits_micros), models: plan.allowed_models.join("\n"), rpm: String(plan.rpm_limit), tpm: String(plan.tpm_limit), concurrency: String(plan.concurrency_limit), stock: String(plan.stock_limit), overage: plan.overage_enabled, enabled: plan.enabled });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "套餐" : "Plans"} description={zh ? "创建周期额度套餐，并配置模型、限速、并发、库存和超额策略。" : "Create recurring plans with model, rate, concurrency, inventory and overage rules."} />
      <Card>
        <CardHeader><CardTitle>{form.id ? (zh ? "编辑套餐" : "Edit plan") : (zh ? "新建套餐" : "New plan")}</CardTitle><CardDescription>{zh ? "额度会在每个周期自动重置；0 表示该项不限制。" : "Credits reset each cycle; zero means unlimited for a limit."}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-3">
          <section className="flex flex-col gap-3">
            <Field label={zh ? "名称" : "Name"}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={zh ? "说明" : "Description"}><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <div className="grid gap-2 sm:grid-cols-3"><Field label={zh ? "周期（天）" : "Cycle days"}><Input type="number" value={form.cycle} onChange={(e) => setForm({ ...form, cycle: e.target.value })} /></Field><Field label={zh ? "包含额度" : "Included credits"}><Input type="number" step="0.000001" value={form.credits} onChange={(e) => setForm({ ...form, credits: e.target.value })} /></Field><Field label={zh ? "库存（0 不限）" : "Inventory (0 unlimited)"}><Input type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></Field></div>
          </section>
          <section className="flex flex-col gap-3">
            <Field label={zh ? "允许模型（每行一个，空为全部）" : "Allowed models (one per line)"}><Textarea rows={5} value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} /></Field>
          </section>
          <section className="flex flex-col gap-3">
            <div className="grid gap-2 min-[420px]:grid-cols-3"><Field label="RPM"><Input type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} /></Field><Field label="TPM"><Input type="number" value={form.tpm} onChange={(e) => setForm({ ...form, tpm: e.target.value })} /></Field><Field label={zh ? "并发" : "Concurrency"}><Input type="number" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} /></Field></div>
            <Toggle label={zh ? "允许超额扣余额" : "Allow wallet overage"} checked={form.overage} onChange={(overage) => setForm({ ...form, overage })} />
            <Toggle label={zh ? "启用套餐" : "Plan enabled"} checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
            <div className="flex gap-2"><Button size="sm" disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}><Plus data-icon="inline-start" />{zh ? "保存" : "Save"}</Button>{form.id ? <Button variant="secondary" size="sm" onClick={() => setForm(emptyForm)}>{zh ? "取消编辑" : "Cancel"}</Button> : null}</div>
          </section>
        </CardContent>
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {!query.data?.items.length ? <Card className="md:col-span-2 xl:col-span-3"><EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无套餐" : "No plans"}</EmptyState></Card> : query.data.items.map((plan) => (
          <Card key={plan.id} className="flex flex-col">
            <CardHeader><div className="flex items-start justify-between gap-2"><div><CardTitle>{plan.name}</CardTitle><CardDescription>{plan.description || "—"}</CardDescription></div><Badge variant={plan.enabled ? "success" : "secondary"}>{plan.enabled ? (zh ? "启用" : "Active") : (zh ? "关闭" : "Off")}</Badge></div></CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3 text-xs">
              <div className="grid grid-cols-2 gap-2"><Stat label={zh ? "周期额度" : "Cycle credits"} value={formatCredits(plan.included_credits_micros)} /><Stat label={zh ? "周期" : "Cycle"} value={`${plan.cycle_days}d`} /><Stat label={zh ? "库存" : "Inventory"} value={plan.stock_limit > 0 ? `${plan.stock_available ?? 0} / ${plan.stock_limit}` : "∞"} /><Stat label={zh ? "已分配" : "Assigned"} value={String(plan.stock_used)} /><Stat label="RPM / TPM" value={`${plan.rpm_limit || "∞"} / ${plan.tpm_limit || "∞"}`} /><Stat label={zh ? "并发" : "Concurrency"} value={String(plan.concurrency_limit || "∞")} /></div>
              <p className="line-clamp-2 text-[11px] text-muted-foreground">{plan.allowed_models.length ? plan.allowed_models.join(", ") : (zh ? "全部模型" : "All models")}</p>
              <div className="mt-auto flex justify-end gap-1"><Button variant="ghost" size="icon" className="size-7" onClick={() => edit(plan)}><Pencil /></Button><Button variant="ghost" size="icon" className="size-7" onClick={() => remove.mutate(plan.id)}><Trash2 /></Button></div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="flex flex-col gap-1.5"><Label>{label}</Label>{children}</label>; }
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2"><span className="text-xs">{label}</span><Switch checked={checked} onCheckedChange={onChange} /></div>; }
function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-md bg-secondary/45 p-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 font-mono tabular-nums">{value}</p></div>; }

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type PlanRow } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { useAppDialog } from "@/components/app-dialog-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { creditsToMicros, formatCredits, formatCreditsInput } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type FormState = {
  id?: string;
  name: string;
  description: string;
  cycle: string;
  price: string;
  credits: string;
  models: string;
  rpm: string;
  tpm: string;
  concurrency: string;
  stock: string;
  overage: boolean;
  enabled: boolean;
  visible: boolean;
};
const emptyForm: FormState = { name: "Coding Plan", description: "", cycle: "30", price: "0", credits: "0", models: "", rpm: "0", tpm: "0", concurrency: "0", stock: "0", overage: true, enabled: true, visible: true };

export function PlansPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const query = useQuery({ queryKey: ["commercial", "plans"], queryFn: api.commercial.plans.list });
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const body = () => ({
    name: form.name.trim(), description: form.description.trim(), cycle_days: Number(form.cycle) || 30,
    price_micros: creditsToMicros(form.price),
    included_credits_micros: creditsToMicros(form.credits),
    allowed_models: form.models.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean),
    rpm_limit: Number(form.rpm) || 0, tpm_limit: Number(form.tpm) || 0,
    concurrency_limit: Number(form.concurrency) || 0, stock_limit: Math.max(0, Number(form.stock) || 0), overage_enabled: form.overage, enabled: form.enabled, visible: form.visible,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["commercial", "plans"] });
  const save = useMutation({
    mutationFn: () => form.id ? api.commercial.plans.update(form.id, body()) : api.commercial.plans.create(body()),
    onSuccess: () => { setForm(emptyForm); setFormOpen(false); toast.success(zh ? "套餐已保存" : "Plan saved"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({ mutationFn: api.commercial.plans.remove, onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const reorder = useMutation({
    mutationFn: api.commercial.plans.reorder,
    onSuccess: (data) => {
      qc.setQueryData(["commercial", "plans"], data);
      toast.success(zh ? "套餐排序已更新" : "Plan order updated");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const edit = (plan: PlanRow) => {
    setForm({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      cycle: String(plan.cycle_days),
      // Use plain numeric strings — locale-formatted credits break type="number" inputs (blank when >= 1000).
      price: formatCreditsInput(plan.price_micros || 0),
      credits: formatCreditsInput(plan.included_credits_micros),
      models: plan.allowed_models.join("\n"),
      rpm: String(plan.rpm_limit),
      tpm: String(plan.tpm_limit),
      concurrency: String(plan.concurrency_limit),
      stock: String(plan.stock_limit),
      overage: plan.overage_enabled,
      enabled: plan.enabled,
      visible: plan.visible !== false,
    });
    setFormOpen(true);
  };
  const requestRemove = async (plan: PlanRow) => { if (await dialogs.confirm({ title: zh ? "删除套餐" : "Delete plan", description: zh ? `确认删除“${plan.name}”？已有用户使用时会改为停用。` : `Delete “${plan.name}”? Active plans will be disabled instead.`, confirmText: zh ? "删除" : "Delete", destructive: true })) remove.mutate(plan.id); };
  const move = (index: number, direction: -1 | 1) => {
    const items = query.data?.items || [];
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "套餐" : "Plans"} description={zh ? "创建周期额度套餐，并配置模型、限速、并发、库存和超额策略。" : "Create recurring plans with model, rate, concurrency, inventory and overage rules."} actions={<Button size="sm" onClick={() => { setForm(emptyForm); setFormOpen(true); }}><Plus data-icon="inline-start" />{zh ? "新建套餐" : "New plan"}</Button>} />
      <Dialog open={formOpen} onOpenChange={(open) => { setFormOpen(open); if (!open) setForm(emptyForm); }}>
        <DialogContent className="max-w-[720px]">
          <DialogHeader><DialogTitle>{form.id ? (zh ? "编辑套餐" : "Edit plan") : (zh ? "新建套餐" : "New plan")}</DialogTitle><DialogDescription>{zh ? "额度每周期自动重置；0 表示该限制不设上限。" : "Credits reset each cycle; zero means unlimited."}</DialogDescription></DialogHeader>
        <form className="mt-4 grid gap-3 lg:grid-cols-3" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
          <section className="flex flex-col gap-3">
            <Field label={zh ? "名称" : "Name"}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={zh ? "说明" : "Description"}><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <div className="grid gap-2 sm:grid-cols-2"><Field label={zh ? "周期价格（余额）" : "Cycle price"}><Input type="number" min="0" step="0.000001" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field><Field label={zh ? "包含额度" : "Included credits"}><Input type="number" min="0" step="0.000001" value={form.credits} onChange={(e) => setForm({ ...form, credits: e.target.value })} /></Field><Field label={zh ? "周期（天）" : "Cycle days"}><Input type="number" value={form.cycle} onChange={(e) => setForm({ ...form, cycle: e.target.value })} /></Field><Field label={zh ? "库存（0 不限）" : "Inventory (0 unlimited)"}><Input type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></Field></div>
          </section>
          <section className="flex flex-col gap-3">
            <Field label={zh ? "允许模型（每行一个，空为全部）" : "Allowed models (one per line)"}><Textarea rows={5} value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} /></Field>
          </section>
          <section className="flex flex-col gap-3">
            <div className="grid gap-2 min-[420px]:grid-cols-3"><Field label="RPM"><Input type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} /></Field><Field label="TPM"><Input type="number" value={form.tpm} onChange={(e) => setForm({ ...form, tpm: e.target.value })} /></Field><Field label={zh ? "并发" : "Concurrency"}><Input type="number" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} /></Field></div>
            <Toggle label={zh ? "允许超额扣余额" : "Allow wallet overage"} checked={form.overage} onChange={(overage) => setForm({ ...form, overage })} />
            <Toggle label={zh ? "启用套餐" : "Plan enabled"} checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
            <Toggle label={zh ? "购买页显示" : "Show on purchase page"} checked={form.visible} onChange={(visible) => setForm({ ...form, visible })} />
          </section>
          <DialogFooter className="lg:col-span-3"><Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button type="submit" disabled={!form.name.trim() || save.isPending}>{save.isPending ? (zh ? "保存中…" : "Saving…") : (zh ? "保存" : "Save")}</Button></DialogFooter>
        </form>
        </DialogContent>
      </Dialog>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {!query.data?.items.length ? <Card className="md:col-span-2 xl:col-span-3"><EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无套餐" : "No plans"}</EmptyState></Card> : query.data.items.map((plan, index) => (
          <Card key={plan.id} className="flex flex-col">
            <CardHeader><div className="flex items-start justify-between gap-2"><div><CardTitle>{plan.name}</CardTitle><CardDescription>{plan.description || "—"}</CardDescription></div><div className="flex shrink-0 flex-col items-end gap-1"><Badge variant={plan.enabled ? "success" : "secondary"}>{plan.enabled ? (zh ? "启用" : "Active") : (zh ? "关闭" : "Off")}</Badge>{plan.visible === false ? <Badge variant="secondary">{zh ? "购买页隐藏" : "Hidden"}</Badge> : null}</div></div></CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3 text-xs">
              <div className="grid grid-cols-2 gap-2"><Stat label={zh ? "周期价格" : "Cycle price"} value={formatCredits(plan.price_micros || 0)} /><Stat label={zh ? "周期额度" : "Cycle credits"} value={formatCredits(plan.included_credits_micros)} /><Stat label={zh ? "周期" : "Cycle"} value={`${plan.cycle_days}d`} /><Stat label={zh ? "库存" : "Inventory"} value={plan.stock_limit > 0 ? `${plan.stock_available ?? 0} / ${plan.stock_limit}` : "∞"} /><Stat label={zh ? "已分配" : "Assigned"} value={String(plan.stock_used)} /><Stat label="RPM / TPM" value={`${plan.rpm_limit || "∞"} / ${plan.tpm_limit || "∞"}`} /><Stat label={zh ? "并发" : "Concurrency"} value={String(plan.concurrency_limit || "∞")} /></div>
              <p className="line-clamp-2 text-[11px] text-muted-foreground">{plan.allowed_models.length ? plan.allowed_models.join(", ") : (zh ? "全部模型" : "All models")}</p>
              <div className="mt-auto flex items-center justify-between gap-2"><div className="flex gap-1"><Button variant="ghost" size="icon" className="size-7" disabled={index === 0 || reorder.isPending} onClick={() => move(index, -1)} aria-label={zh ? "上移套餐" : "Move plan up"}><ArrowUp /></Button><Button variant="ghost" size="icon" className="size-7" disabled={index === query.data.items.length - 1 || reorder.isPending} onClick={() => move(index, 1)} aria-label={zh ? "下移套餐" : "Move plan down"}><ArrowDown /></Button></div><div className="flex gap-1"><Button variant="ghost" size="icon" className="size-7" onClick={() => edit(plan)}><Pencil /></Button><Button variant="ghost" size="icon" className="size-7" onClick={() => requestRemove(plan)}><Trash2 /></Button></div></div>
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

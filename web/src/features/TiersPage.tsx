import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type UserTier } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { useAppDialog } from "@/components/app-dialog-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { creditsToMicros, formatCredits } from "@/lib/utils";

type TierForm = { id?: string; name: string; description: string; threshold: string; rpm: string; tpm: string; concurrency: string; enabled: boolean };
const emptyForm: TierForm = { name: "", description: "", threshold: "0", rpm: "60", tpm: "100000", concurrency: "5", enabled: true };

export function TiersPage() {
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const query = useQuery({ queryKey: ["commercial", "tiers"], queryFn: api.commercial.tiers.list });
  const [form, setForm] = useState<TierForm>(emptyForm);
  const [open, setOpen] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["commercial", "tiers"] }); qc.invalidateQueries({ queryKey: ["commercial", "users"] }); };
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), description: form.description.trim(), threshold_micros: creditsToMicros(form.threshold), rpm_limit: Number(form.rpm) || 0, tpm_limit: Number(form.tpm) || 0, concurrency_limit: Number(form.concurrency) || 0, enabled: form.enabled };
      return form.id ? api.commercial.tiers.update(form.id, body) : api.commercial.tiers.create(body as Omit<UserTier, "id" | "created_at" | "updated_at">);
    },
    onSuccess: () => { setOpen(false); setForm(emptyForm); toast.success("用户层级已保存"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({ mutationFn: api.commercial.tiers.remove, onSuccess: () => { toast.success("用户层级已删除"); refresh(); }, onError: (error: Error) => toast.error(error.message) });
  const edit = (tier: UserTier) => { setForm({ id: tier.id, name: tier.name, description: tier.description, threshold: formatCredits(tier.threshold_micros), rpm: String(tier.rpm_limit), tpm: String(tier.tpm_limit), concurrency: String(tier.concurrency_limit), enabled: tier.enabled }); setOpen(true); };
  const requestDelete = async (tier: UserTier) => {
    if (await dialogs.confirm({ title: "删除用户层级", description: `确认删除“${tier.name}”？用户会立即重新匹配剩余层级。基础层级不能被删除。`, confirmText: "删除", destructive: true })) remove.mutate(tier.id);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="用户层级" description="根据累计净充值额度自动匹配层级；权益只限制余额模式调用，不影响 Coding Plan。" actions={<Button size="sm" onClick={() => { setForm(emptyForm); setOpen(true); }}><Plus data-icon="inline-start" />新建层级</Button>} />
      {!query.data?.items.length ? <Card><EmptyState>{query.isLoading ? "加载中…" : "暂无用户层级"}</EmptyState></Card> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{query.data.items.map((tier) => <Card key={tier.id}><CardHeader><div className="flex items-start justify-between gap-3"><div className="min-w-0"><CardTitle className="truncate">{tier.name}</CardTitle><CardDescription>{tier.description || "余额调用层级"}</CardDescription></div><Badge variant={tier.enabled ? "success" : "secondary"}>{tier.enabled ? "启用" : "停用"}</Badge></div></CardHeader><CardContent className="flex flex-col gap-3"><div className="rounded-md bg-secondary/45 p-3"><p className="text-[11px] text-muted-foreground">累计净充值达到</p><p className="mt-1 font-mono text-xl font-medium tabular-nums">{formatCredits(tier.threshold_micros)}</p></div><div className="grid grid-cols-3 gap-2 text-xs"><Stat label="RPM" value={tier.rpm_limit || "∞"} /><Stat label="TPM" value={tier.tpm_limit || "∞"} /><Stat label="并发" value={tier.concurrency_limit || "∞"} /></div><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" className="size-7" onClick={() => edit(tier)}><Pencil /></Button><Button variant="ghost" size="icon" className="size-7" onClick={() => requestDelete(tier)}><Trash2 /></Button></div></CardContent></Card>)}</div>}

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setForm(emptyForm); }}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader><DialogTitle>{form.id ? "编辑用户层级" : "新建用户层级"}</DialogTitle><DialogDescription>阈值按累计成功充值减去退款后的账户额度计算，0 表示基础层级。</DialogDescription></DialogHeader>
          <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (form.name.trim()) save.mutate(); }}>
            <div className="grid gap-3 sm:grid-cols-2"><Field label="层级名称"><Input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="充值阈值（账户额度）"><Input type="number" min="0" step="0.000001" value={form.threshold} onChange={(event) => setForm({ ...form, threshold: event.target.value })} /></Field></div>
            <Field label="权益说明"><Textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-2"><Field label="RPM"><Input type="number" min="0" value={form.rpm} onChange={(event) => setForm({ ...form, rpm: event.target.value })} /></Field><Field label="TPM"><Input type="number" min="0" value={form.tpm} onChange={(event) => setForm({ ...form, tpm: event.target.value })} /></Field><Field label="并发"><Input type="number" min="0" value={form.concurrency} onChange={(event) => setForm({ ...form, concurrency: event.target.value })} /></Field></div>
            <div className="flex items-center justify-between rounded-md bg-secondary/45 px-3 py-2.5"><div><p className="text-xs">启用层级</p><p className="mt-0.5 text-[11px] text-muted-foreground">停用后不会参与用户自动匹配。</p></div><Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} /></div>
            <DialogFooter className="mt-0"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>取消</Button><Button type="submit" disabled={!form.name.trim() || save.isPending}>{save.isPending ? "保存中…" : "保存"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="flex min-w-0 flex-col gap-1.5"><Label>{label}</Label>{children}</label>; }
function Stat({ label, value }: { label: string; value: string | number }) { return <div className="rounded-md bg-secondary/45 p-2"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono tabular-nums">{value}</p></div>; }

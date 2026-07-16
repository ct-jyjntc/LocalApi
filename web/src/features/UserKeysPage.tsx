import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Plus, Trash2 } from "lucide-react";
import { userApi, type ApiKeyRow } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserKeysPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["user", "keys"], queryFn: userApi.keys.list });
  const me = useQuery({ queryKey: ["user", "me"], queryFn: userApi.me });
  const [form, setForm] = useState({ name: "", models: "", rpm: "0", tpm: "0", concurrency: "0", expires: "" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["user", "keys"] });
  const create = useMutation({
    mutationFn: () => userApi.keys.create({
      name: form.name.trim() || "default",
      allowed_models: form.models.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean),
      rate_limit: Number(form.rpm) || 0,
      tpm_limit: Number(form.tpm) || 0,
      concurrency_limit: Number(form.concurrency) || 0,
      expires_at: form.expires ? new Date(form.expires).toISOString() : null,
    }),
    onSuccess: async (row) => {
      if (row.key) await navigator.clipboard.writeText(row.key).catch(() => undefined);
      setForm({ name: "", models: "", rpm: "0", tpm: "0", concurrency: "0", expires: "" });
      toast.success(zh ? "API Key 已创建并复制" : "API key created and copied");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => userApi.keys.update(id, { enabled }), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: userApi.keys.remove, onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="API Keys" description={zh ? "创建独立密钥并设置模型、RPM、TPM、并发和到期时间。" : "Create keys with model, RPM, TPM, concurrency and expiry controls."} />
      <Card>
        <CardHeader><CardTitle>{zh ? "创建 API Key" : "Create API key"}</CardTitle><CardDescription>{zh ? "空限制表示继承用户和套餐限制；最终采用最严格的一层。" : "Zero or empty values inherit account and plan limits; the strictest layer wins."}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-3">
          <section className="flex flex-col gap-3"><Field label={zh ? "名称" : "Name"}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field><Field label={zh ? "到期时间" : "Expires"}><Input type="datetime-local" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} /></Field></section>
          <section><Field label={zh ? "允许模型（每行一个，空为全部）" : "Allowed models (one per line)"}><Textarea rows={5} value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder={(me.data?.prices ?? []).map((p) => p.model).join("\n")} /></Field></section>
          <section className="flex flex-col gap-3"><div className="grid grid-cols-3 gap-2"><Field label="RPM"><Input type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} /></Field><Field label="TPM"><Input type="number" value={form.tpm} onChange={(e) => setForm({ ...form, tpm: e.target.value })} /></Field><Field label={zh ? "并发" : "Concurrency"}><Input type="number" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} /></Field></div><Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}><Plus data-icon="inline-start" />{zh ? "创建并复制" : "Create and copy"}</Button></section>
        </CardContent>
      </Card>
      <Card className="overflow-hidden">
        <div className={TABLE_HEAD_CLASS}><span className="w-32 shrink-0">{zh ? "名称" : "Name"}</span><span className="min-w-0 flex-1">Key</span><span className="hidden w-44 shrink-0 lg:block">{zh ? "限制" : "Limits"}</span><span className="w-24 shrink-0 text-right">{zh ? "操作" : "Actions"}</span></div>
        {!query.data?.items.length ? <EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无 Key" : "No keys"}</EmptyState> : query.data.items.map((row) => <KeyRow key={row.id} row={row} zh={zh} onToggle={(enabled) => toggle.mutate({ id: row.id, enabled })} onRemove={() => remove.mutate(row.id)} />)}
      </Card>
    </div>
  );
}

function KeyRow({ row, zh, onToggle, onRemove }: { row: ApiKeyRow; zh: boolean; onToggle: (enabled: boolean) => void; onRemove: () => void }) {
  const copy = async () => { if (row.key) { await navigator.clipboard.writeText(row.key); toast.success(zh ? "已复制" : "Copied"); } };
  return <div className={TABLE_ROW_CLASS}>
    <span className="w-32 shrink-0 truncate">{row.name}</span>
    <span className="flex min-w-0 flex-1 items-center gap-1"><code className="min-w-0 flex-1 truncate font-mono text-[11px]">{row.key || `${row.key_prefix}…`}</code>{row.key ? <Button variant="ghost" size="icon" className="size-6" onClick={copy}><Copy /></Button> : null}</span>
    <span className="hidden w-44 shrink-0 truncate text-[11px] text-muted-foreground lg:block">RPM {row.rate_limit || "∞"} · TPM {row.tpm_limit || "∞"} · {zh ? "并发" : "C"} {row.concurrency_limit || "∞"}{row.expires_at ? ` · ${shortTime(row.expires_at)}` : ""}</span>
    <span className="flex w-24 shrink-0 items-center justify-end gap-1"><Badge variant={row.enabled ? "success" : "secondary"}>{row.enabled ? (zh ? "启用" : "Active") : (zh ? "关闭" : "Off")}</Badge><Switch checked={row.enabled} onCheckedChange={onToggle} /><Button variant="ghost" size="icon" className="size-6" onClick={onRemove}><Trash2 /></Button></span>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="flex flex-col gap-1.5"><Label>{label}</Label>{children}</label>; }

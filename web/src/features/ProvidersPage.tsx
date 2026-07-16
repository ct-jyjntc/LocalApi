import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { FlaskConical, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type Provider, type ProviderTestResult } from "@/lib/api";
import {
  EmptyState,
  PageHeader,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { useAppDialog } from "@/components/app-dialog-context";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const emptyForm = {
  name: "",
  base_url: "",
  api_keys: "",
  models: "glm-5.2\nmock-echo",
  enabled: true,
  timeout_ms: 60000,
};

function parseKeys(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ProvidersPage() {
  const { t } = useI18n();
  const dialogs = useAppDialog();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.providers.list(),
  });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [testResult, setTestResult] = useState<{ provider: Provider; result: ProviderTestResult } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const models = form.models
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const keys = parseKeys(form.api_keys);

      if (editing) {
        return api.providers.update(editing.id, {
          name: form.name,
          base_url: form.base_url,
          // A blank field preserves encrypted credentials already on the server.
          ...(keys.length > 0 ? { api_keys: keys } : {}),
          models,
          enabled: form.enabled,
          timeout_ms: form.timeout_ms,
        });
      }

      return api.providers.create({
        name: form.name,
        base_url: form.base_url,
        api_keys: keys,
        models,
        enabled: form.enabled,
        timeout_ms: form.timeout_ms,
      });
    },
    onSuccess: () => {
      toast.success(editing ? t("providers.saved") : t("providers.created"));
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.providers.remove(id),
    onSuccess: () => {
      toast.success(t("providers.removed"));
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.providers.update(id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast.success(t("providers.updated"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testProvider = useMutation({
    mutationFn: ({ provider, model }: { provider: Provider; model: string }) =>
      api.providers.test(provider.id, model),
    onSuccess: (result, variables) => {
      setTestResult({ provider: variables.provider, result });
      if (result.ok) toast.success(t("providers.testSuccess"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function startCreate() {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function startEdit(p: Provider) {
    setEditing(p);
    const existingKeys =
      p.api_keys && p.api_keys.length > 0
        ? p.api_keys
        : p.api_key
          ? [p.api_key]
          : [];
    setForm({
      name: p.name,
      base_url: p.base_url,
      api_keys: existingKeys.join("\n"),
      models: p.models.join("\n"),
      enabled: p.enabled,
      timeout_ms: p.timeout_ms,
    });
    setOpen(true);
  }

  async function startTest(provider: Provider) {
    let model = provider.models.find((item) => item && item !== "*") || "";
    if (!model) {
      const selected = await dialogs.prompt({
        title: t("providers.testTitle"),
        description: t("providers.testModelHint"),
        label: t("providers.testModel"),
        placeholder: "gpt-4o-mini",
        confirmText: t("providers.test"),
        required: true,
      });
      if (!selected) return;
      model = selected;
    }
    testProvider.mutate({ provider, model });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <PageHeader
        title={t("providers.title")}
        description={t("providers.desc")}
        actions={
          <Button size="sm" onClick={startCreate}>
            <Plus strokeWidth={1.8} />
            {t("providers.add")}
          </Button>
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[640px]">
          <DialogHeader><DialogTitle>{editing ? t("providers.edit") : t("providers.new")}</DialogTitle><DialogDescription>{t("providers.desc")}</DialogDescription></DialogHeader>
          <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
            <Field label={t("common.name")}>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="商汤日日新"
              />
            </Field>
            <Field label={t("providers.baseUrl")}>
              <Input
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://token.sensenova.cn"
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t("providers.apiKeys")}>
                <Textarea
                  rows={4}
                  spellCheck={false}
                  className="font-mono text-[11px]"
                  value={form.api_keys}
                  onChange={(e) =>
                    setForm({ ...form, api_keys: e.target.value })
                  }
                  placeholder={"sk-key-1\nsk-key-2\nsk-key-3"}
                />
              </Field>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("providers.apiKeysHint")}
                {parseKeys(form.api_keys).length > 0
                  ? ` · ${t("providers.keyCount", {
                      n: parseKeys(form.api_keys).length,
                    })}`
                  : null}
              </p>
            </div>
            <Field label={t("providers.timeout")}>
              <Input
                type="number"
                value={form.timeout_ms}
                onChange={(e) =>
                  setForm({
                    ...form,
                    timeout_ms: Number(e.target.value) || 60000,
                  })
                }
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t("providers.models")}>
                <Textarea
                  rows={3}
                  value={form.models}
                  onChange={(e) => setForm({ ...form, models: e.target.value })}
                />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2 sm:col-span-2">
              <div>
                <p className="text-xs text-foreground">{t("common.enabled")}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t("providers.enabledHint")}
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
                aria-label={t("common.enabled")}
              />
            </div>
            <DialogFooter className="sm:col-span-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={!form.name || !form.base_url || save.isPending}>{save.isPending ? t("common.loading") : t("common.save")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(testResult)} onOpenChange={(next) => { if (!next) setTestResult(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("providers.testTitle")} · {testResult?.provider.name}</DialogTitle>
            <DialogDescription>{testResult?.result.ok ? t("providers.testSuccessDesc") : t("providers.testFailedDesc")}</DialogDescription>
          </DialogHeader>
          {testResult ? <div className="mt-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/40 px-3 py-2.5">
              <div className="min-w-0"><p className="text-[11px] text-muted-foreground">{t("providers.testStatus")}</p><p className="truncate text-sm font-medium">{testResult.result.ok ? t("providers.testPassed") : t("providers.testFailed")}</p></div>
              <Badge variant={testResult.result.ok ? "success" : "destructive"}>{testResult.result.status_code ?? "—"}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <TestStat label={t("providers.testModel")} value={testResult.result.model || "—"} />
              <TestStat label={t("providers.testAttempts")} value={`${testResult.result.attempts} / ${testResult.result.max_retries + 1}`} />
              <TestStat label={t("providers.testLatency")} value={`${testResult.result.latency_ms} ms`} />
              <TestStat label={t("providers.testPath")} value={testResult.result.path} />
            </div>
            {testResult.result.error ? <div className="rounded-md bg-destructive/8 px-3 py-2.5"><p className="text-[11px] text-destructive">{t("providers.testError")}</p><p className="mt-1 break-words font-mono text-[11px] leading-5">{testResult.result.error}</p></div> : null}
            {testResult.result.response_preview ? <div className="rounded-md bg-secondary/40 px-3 py-2.5"><p className="text-[11px] text-muted-foreground">{t("providers.testResponse")}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{testResult.result.response_preview}</pre></div> : null}
          </div> : null}
          <DialogFooter><Button variant="secondary" onClick={() => setTestResult(null)}>{t("common.close")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="overflow-hidden">
        {!data?.items?.length ? (
          <EmptyState>
            {isLoading ? t("common.loading") : t("providers.empty")}
          </EmptyState>
        ) : (
          <>
            <div className="divide-y divide-border/40 md:hidden">
              {data.items.map((p) => (
                <div key={p.id} className="flex flex-col gap-2.5 p-3 text-xs">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <p className="min-w-0 truncate font-medium">{p.name}</p>
                    {p.enabled ? <Badge variant="success">{t("common.active")}</Badge> : <Badge variant="secondary">{t("common.off")}</Badge>}
                  </div>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">{p.base_url}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{t("providers.keysCol")} <span className="tabular-nums text-foreground">{p.key_count ?? (p.has_api_key ? 1 : 0)}</span></span>
                    <span className="min-w-0 break-all">{t("providers.modelsCol")} {p.models.join(", ") || "—"}</span>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="secondary" size="sm" disabled={testProvider.isPending && testProvider.variables?.provider.id === p.id} onClick={() => startTest(p)}>{testProvider.isPending && testProvider.variables?.provider.id === p.id ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <FlaskConical data-icon="inline-start" />}{t("providers.test")}</Button>
                    <Switch checked={p.enabled} onCheckedChange={(v) => toggle.mutate({ id: p.id, enabled: v })} aria-label={`Toggle ${p.name}`} />
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => startEdit(p)} aria-label="Edit"><Pencil className="size-3.5" strokeWidth={1.8} /></Button>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: p.name, description: t("providers.deleteConfirm", { name: p.name }), confirmText: "Delete", destructive: true })) remove.mutate(p.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block">
              <div className={TABLE_HEAD_CLASS}>
                <span className="w-36">{t("common.name")}</span><span className="min-w-0 flex-1">{t("providers.baseUrl")}</span><span className="w-16 text-right">{t("providers.keysCol")}</span><span className="w-36">{t("providers.modelsCol")}</span><span className="w-16">{t("common.status")}</span><span className="w-32 text-right">{t("common.actions")}</span>
              </div>
              {data.items.map((p) => (
                <div key={p.id} className={TABLE_ROW_CLASS}>
                  <span className="w-36 truncate font-medium">{p.name}</span><span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{p.base_url}</span><span className="w-16 text-right tabular-nums">{p.key_count ?? (p.has_api_key ? 1 : 0)}</span><span className="w-36 truncate text-muted-foreground">{p.models.slice(0, 2).join(", ")}{p.models.length > 2 ? ` +${p.models.length - 2}` : ""}</span><span className="w-16">{p.enabled ? <Badge variant="success">{t("common.active")}</Badge> : <Badge variant="secondary">{t("common.off")}</Badge>}</span>
                  <span className="flex w-32 items-center justify-end gap-1"><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" disabled={testProvider.isPending && testProvider.variables?.provider.id === p.id} onClick={() => startTest(p)} aria-label={t("providers.test")} title={t("providers.test")}>{testProvider.isPending && testProvider.variables?.provider.id === p.id ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}</Button><Switch checked={p.enabled} onCheckedChange={(v) => toggle.mutate({ id: p.id, enabled: v })} aria-label={`Toggle ${p.name}`} /><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={() => startEdit(p)} aria-label="Edit"><Pencil className="size-3.5" strokeWidth={1.8} /></Button><Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: p.name, description: t("providers.deleteConfirm", { name: p.name }), confirmText: "Delete", destructive: true })) remove.mutate(p.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button></span>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function TestStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-md bg-secondary/40 px-3 py-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 truncate font-mono tabular-nums" title={value}>{value}</p></div>;
}

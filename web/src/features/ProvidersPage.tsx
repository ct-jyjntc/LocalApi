import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, type Provider } from "@/lib/api";
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
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.providers.list(),
  });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [form, setForm] = useState(emptyForm);

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
          // Full key list is always editable & visible — save as shown
          api_keys: keys,
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
      // Full keys prefilled — visible and editable anytime
      api_keys: existingKeys.join("\n"),
      models: p.models.join("\n"),
      enabled: p.enabled,
      timeout_ms: p.timeout_ms,
    });
    setOpen(true);
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

      {open ? (
        <Card className="space-y-4 p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">
              {editing ? t("providers.edit") : t("providers.new")}
            </h2>
            <Button
              variant="secondary"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              disabled={!form.name || !form.base_url || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? t("common.loading") : t("common.save")}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <div className={TABLE_HEAD_CLASS}>
          <span className="w-36">{t("common.name")}</span>
          <span className="min-w-0 flex-1">{t("providers.baseUrl")}</span>
          <span className="w-16 text-right">{t("providers.keysCol")}</span>
          <span className="w-36">{t("providers.modelsCol")}</span>
          <span className="w-16">{t("common.status")}</span>
          <span className="w-24 text-right">{t("common.actions")}</span>
        </div>
        {!data?.items?.length ? (
          <EmptyState>
            {isLoading ? t("common.loading") : t("providers.empty")}
          </EmptyState>
        ) : (
          data.items.map((p) => (
            <div key={p.id} className={TABLE_ROW_CLASS}>
              <span className="w-36 truncate font-medium">{p.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {p.base_url}
              </span>
              <span className="w-16 text-right tabular-nums">
                {p.key_count ?? (p.has_api_key ? 1 : 0)}
              </span>
              <span className="w-36 truncate text-muted-foreground">
                {p.models.slice(0, 2).join(", ")}
                {p.models.length > 2 ? ` +${p.models.length - 2}` : ""}
              </span>
              <span className="w-16">
                {p.enabled ? (
                  <Badge variant="success">{t("common.active")}</Badge>
                ) : (
                  <Badge variant="secondary">{t("common.off")}</Badge>
                )}
              </span>
              <span className="flex w-24 items-center justify-end gap-1">
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) =>
                    toggle.mutate({ id: p.id, enabled: v })
                  }
                  aria-label={`Toggle ${p.name}`}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  onClick={() => startEdit(p)}
                  aria-label="Edit"
                >
                  <Pencil className="size-3.5" strokeWidth={1.8} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (
                      confirm(t("providers.deleteConfirm", { name: p.name }))
                    ) {
                      remove.mutate(p.id);
                    }
                  }}
                  aria-label="Delete"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.8} />
                </Button>
              </span>
            </div>
          ))
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, FlaskConical, GripVertical, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
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
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useAppDialog } from "@/components/app-dialog-context";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const emptyForm = {
  name: "",
  base_url: "",
  api_keys: "",
  models: "glm-5.2\nmock-echo",
  proxy_ids: [] as string[],
  enabled: true,
  timeout_ms: 60000,
  custom_headers: "",
  protocols: ["openai-completions"] as string[],
};

const PROTOCOL_OPTIONS = [
  { id: "openai-completions", label: "OpenAI Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
] as const;

/** Parse "Key: Value" lines into a Record. */
function parseCustomHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** Parse "public" / "public => upstream" lines, with optional effort mapping after "|". */
function parseModelsEditor(raw: string): {
  models: string[];
  model_mappings: Record<string, string>;
  model_efforts: Record<string, Record<string, string>>;
} {
  const models: string[] = [];
  const model_mappings: Record<string, string> = {};
  const model_efforts: Record<string, Record<string, string>> = {};
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [modelPart, effortPart] = trimmed.split("|").map((part) => part.trim());
    const match = modelPart.match(/^(.+?)\s*(?:=>|->|=)\s*(.+)$/);
    const publicName = (match ? match[1] : modelPart).trim();
    const upstreamName = (match ? match[2] : "").trim();
    if (!publicName || seen.has(publicName)) continue;
    seen.add(publicName);
    models.push(publicName);
    if (upstreamName && upstreamName !== publicName) {
      model_mappings[publicName] = upstreamName;
    }
    if (effortPart) {
      // "low, max:high" → { low: "low", max: "high" } (bare effort = identity)
      const mapping: Record<string, string> = {};
      for (const entry of effortPart.split(",")) {
        const item = entry.trim();
        if (!item) continue;
        const pair = item.split(":");
        const from = (pair[0] || "").trim();
        const to = (pair.length > 1 ? pair[1] : pair[0] || "").trim();
        if (from && to) mapping[from] = to;
      }
      if (Object.keys(mapping).length > 0) model_efforts[publicName] = mapping;
    }
  }
  return { models, model_mappings, model_efforts };
}

function formatModelsEditor(
  models: string[],
  mappings: Record<string, string> = {},
  efforts: Record<string, Record<string, string>> = {},
): string {
  return models
    .map((model) => {
      const upstream = mappings[model]?.trim();
      let line = upstream && upstream !== model ? `${model} => ${upstream}` : model;
      const effortMap = efforts[model];
      if (effortMap && Object.keys(effortMap).length > 0) {
        const parts = Object.entries(effortMap).map(([from, to]) => (from === to ? from : `${from}:${to}`));
        line += ` | ${parts.join(", ")}`;
      }
      return line;
    })
    .join("\n");
}

type ModelTestItem = {
  model: string;
  status: "pending" | "running" | "ok" | "error";
  result?: ProviderTestResult;
  error?: string;
};

function parseKeys(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function concreteModels(models: string[]) {
  return models.map((item) => item.trim()).filter((item) => item && item !== "*");
}

export function ProvidersPage() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const dialogs = useAppDialog();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["providers"],
    queryFn: () => api.providers.list(),
  });
  const { data: proxyData } = useQuery({
    queryKey: ["proxies"],
    queryFn: () => api.proxies.list(),
  });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [testProvider, setTestProvider] = useState<Provider | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState("");
  const [testPhase, setTestPhase] = useState<"select" | "results">("select");
  const [testItems, setTestItems] = useState<ModelTestItem[]>([]);
  const [testing, setTesting] = useState(false);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragId = useRef<string | null>(null);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.providers.reorder(ids),
    onSuccess: () => {
      toast.success("优先级已更新");
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const handleDragStart = (index: number, id: string) => {
    setDragIndex(index);
    dragId.current = id;
  };
  const handleDragOver = (event: React.DragEvent, index: number) => {
    event.preventDefault();
    if (dragIndex !== null && dragIndex !== index) setOverIndex(index);
  };
  const handleDrop = (event: React.DragEvent, index: number) => {
    event.preventDefault();
    if (dragIndex === null || dragIndex === index || !data?.items) return;
    const items = [...data.items];
    const [moved] = items.splice(dragIndex, 1);
    items.splice(index, 0, moved);
    reorder.mutate(items.map((p) => p.id));
    setDragIndex(null);
    setOverIndex(null);
    dragId.current = null;
  };
  const handleDragEnd = () => {
    setDragIndex(null);
    setOverIndex(null);
    dragId.current = null;
  };

  const save = useMutation({
    mutationFn: async () => {
      const { models, model_mappings, model_efforts } = parseModelsEditor(form.models);
      const keys = parseKeys(form.api_keys);

      if (editing) {
        return api.providers.update(editing.id, {
          name: form.name,
          base_url: form.base_url,
          ...(keys.length > 0 ? { api_keys: keys } : {}),
          models,
          model_mappings,
          model_efforts,
          proxy_ids: form.proxy_ids,
          enabled: form.enabled,
          timeout_ms: form.timeout_ms,
          custom_headers: parseCustomHeaders(form.custom_headers),
          protocols: form.protocols,
        });
      }

      return api.providers.create({
        name: form.name,
        base_url: form.base_url,
        api_keys: keys,
        models,
        model_mappings,
        model_efforts,
        proxy_ids: form.proxy_ids,
        enabled: form.enabled,
        timeout_ms: form.timeout_ms,
        custom_headers: parseCustomHeaders(form.custom_headers),
        protocols: form.protocols,
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

  const availableModels = useMemo(
    () => (testProvider ? concreteModels(testProvider.models) : []),
    [testProvider],
  );

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
      models: formatModelsEditor(p.models, p.model_mappings || {}, p.model_efforts || {}),
      proxy_ids: p.proxy_ids ?? [],
      enabled: p.enabled,
      timeout_ms: p.timeout_ms,
      custom_headers: Object.entries(p.custom_headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n"),
      protocols: p.protocols?.length ? p.protocols : ["openai-completions"],
    });
    setOpen(true);
  }

  function closeTestDialog() {
    if (testing) return;
    setTestProvider(null);
    setSelectedModels([]);
    setCustomModel("");
    setTestPhase("select");
    setTestItems([]);
    setExpandedModel(null);
  }

  function startTest(provider: Provider) {
    const models = concreteModels(provider.models);
    setTestProvider(provider);
    setSelectedModels(models);
    setCustomModel("");
    setTestPhase("select");
    setTestItems([]);
    setExpandedModel(null);
  }

  function toggleModel(model: string) {
    setSelectedModels((current) =>
      current.includes(model)
        ? current.filter((item) => item !== model)
        : [...current, model],
    );
  }

  function addCustomModel() {
    const model = customModel.trim();
    if (!model || model === "*") return;
    setSelectedModels((current) =>
      current.includes(model) ? current : [...current, model],
    );
    setCustomModel("");
  }

  async function runSelectedTests() {
    if (!testProvider) return;
    const models = selectedModels
      .map((item) => item.trim())
      .filter((item) => item && item !== "*");
    if (models.length === 0) {
      toast.error(t("providers.testSelectRequired"));
      return;
    }

    const uniqueModels = [...new Set(models)];
    setTesting(true);
    setTestPhase("results");
    setExpandedModel(uniqueModels[0] ?? null);
    setTestItems(uniqueModels.map((model) => ({ model, status: "pending" })));

    let passed = 0;
    let failed = 0;

    for (const model of uniqueModels) {
      setTestItems((current) =>
        current.map((item) =>
          item.model === model ? { ...item, status: "running" } : item,
        ),
      );
      setExpandedModel(model);

      try {
        const result = await api.providers.test(testProvider.id, model);
        if (result.ok) passed += 1;
        else failed += 1;
        setTestItems((current) =>
          current.map((item) =>
            item.model === model
              ? { ...item, status: result.ok ? "ok" : "error", result }
              : item,
          ),
        );
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : t("providers.testFailed");
        setTestItems((current) =>
          current.map((item) =>
            item.model === model
              ? { ...item, status: "error", error: message }
              : item,
          ),
        );
      }
    }

    setTesting(false);
    if (failed === 0) {
      toast.success(t("providers.testAllPassed", { n: passed }));
    } else if (passed === 0) {
      toast.error(t("providers.testAllFailed", { n: failed }));
    } else {
      toast.message(t("providers.testPartial", { passed, failed }));
    }
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
              <Field label={zh ? "支持协议" : "Protocols"}>
                <div className="flex flex-wrap gap-2">
                  {PROTOCOL_OPTIONS.map((option) => {
                    const active = form.protocols.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => {
                          // First checked entry is the preferred dialect used
                          // when a foreign client dialect must be translated.
                          const next = active
                            ? form.protocols.filter((id) => id !== option.id)
                            : [...form.protocols, option.id];
                          if (next.length === 0) return;
                          setForm({ ...form, protocols: next });
                        }}
                        className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                          active
                            ? "border-foreground/40 bg-foreground/10 text-foreground"
                            : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {zh
                  ? "该渠道上游支持的 API 协议。客户端用其他协议请求时自动转换；未勾选的协议不会被使用。"
                  : "API dialects this channel's upstream supports. Requests in other dialects are translated automatically."}
              </p>
            </div>
            <div className="sm:col-span-2">
              <Field label={t("providers.models")}>
                <Textarea
                  rows={5}
                  spellCheck={false}
                  className="font-mono text-[11px]"
                  value={form.models}
                  onChange={(e) => setForm({ ...form, models: e.target.value })}
                  placeholder={"qwen3.7-max => openrouter/qwen/qwen3.7-max\nkimi-k2.6\nglm-5.2"}
                />
              </Field>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("providers.modelsHint")}</p>
            </div>
            <div className="sm:col-span-2">
              <Field label={t("providers.proxies")}>
                {(proxyData?.libraries.length || proxyData?.items.length) ? (
                  <div className="flex flex-wrap gap-2">
                    {proxyData!.libraries.map((lib) => {
                      const active = form.proxy_ids.includes(lib.id);
                      return (
                        <button
                          key={lib.id}
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              proxy_ids: active
                                ? form.proxy_ids.filter((id) => id !== lib.id)
                                : [...form.proxy_ids, lib.id],
                            })
                          }
                          title={t("providers.proxiesHint")}
                          className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                            active
                              ? "border-foreground/40 bg-foreground/10 text-foreground"
                              : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground"
                          } ${lib.enabled ? "" : "opacity-50"}`}
                        >
                          {lib.name} · {lib.node_count}
                          {!lib.enabled ? "（停用）" : ""}
                        </button>
                      );
                    })}
                    {proxyData!.items.map((node) => {
                      const active = form.proxy_ids.includes(node.id);
                      return (
                        <button
                          key={node.id}
                          type="button"
                          onClick={() =>
                            setForm({
                              ...form,
                              proxy_ids: active
                                ? form.proxy_ids.filter((id) => id !== node.id)
                                : [...form.proxy_ids, node.id],
                            })
                          }
                          className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                            active
                              ? "border-foreground/40 bg-foreground/10 text-foreground"
                              : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground"
                          } ${node.enabled ? "" : "opacity-50"}`}
                        >
                          {node.name}
                          {!node.enabled ? "（停用）" : ""}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {t("providers.proxiesNone")}
                  </p>
                )}
              </Field>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("providers.proxiesHint")}</p>
            </div>
            <div className="sm:col-span-2">
              <Field label={zh ? "自定义请求头" : "Custom headers"}>
                <Textarea
                  rows={3}
                  spellCheck={false}
                  className="font-mono text-[11px]"
                  value={form.custom_headers}
                  onChange={(e) => setForm({ ...form, custom_headers: e.target.value })}
                  placeholder={"User-Agent: eve/0.27.8\nX-Custom-Header: value"}
                />
              </Field>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {zh ? "每行一个，格式：Header: Value。Authorization 和 Host 不可自定义。" : "One per line, format: Header: Value. Authorization and Host are excluded."}
              </p>
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

      <Dialog
        open={Boolean(testProvider)}
        onOpenChange={(next) => {
          if (!next) closeTestDialog();
        }}
      >
        <DialogContent className="max-w-[680px]">
          <DialogHeader>
            <DialogTitle>
              {t("providers.testTitle")}{testProvider ? ` · ${testProvider.name}` : ""}
            </DialogTitle>
            <DialogDescription>
              {testPhase === "select"
                ? t("providers.testSelectDesc")
                : testing
                  ? t("providers.testRunningDesc")
                  : t("providers.testResultsDesc")}
            </DialogDescription>
          </DialogHeader>

          {testPhase === "select" ? (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {t("providers.testSelectedCount", { n: selectedModels.length })}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={availableModels.length === 0}
                    onClick={() => setSelectedModels(availableModels)}
                  >
                    {t("providers.testSelectAll")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    disabled={selectedModels.length === 0}
                    onClick={() => setSelectedModels([])}
                  >
                    {t("providers.testClearAll")}
                  </Button>
                </div>
              </div>

              {availableModels.length > 0 ? (
                <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-border/60 p-2">
                  {availableModels.map((model) => {
                    const checked = selectedModels.includes(model);
                    return (
                      <button
                        key={model}
                        type="button"
                        onClick={() => toggleModel(model)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                          checked ? "bg-primary/8" : "hover:bg-secondary/60",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded border",
                            checked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background",
                          )}
                        >
                          {checked ? <Check className="size-3" strokeWidth={2.4} /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{model}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md bg-secondary/45 px-3 py-2.5 text-[11px] text-muted-foreground">
                  {t("providers.testNoModelsHint")}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>{t("providers.testCustomModel")}</Label>
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    value={customModel}
                    placeholder="gpt-4o-mini"
                    onChange={(event) => setCustomModel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomModel();
                      }
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={addCustomModel} disabled={!customModel.trim()}>
                    {t("providers.testAddModel")}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">{t("providers.testCustomModelHint")}</p>
              </div>

              {selectedModels.some((model) => !availableModels.includes(model)) ? (
                <div className="flex flex-wrap gap-1.5">
                  {selectedModels
                    .filter((model) => !availableModels.includes(model))
                    .map((model) => (
                      <button
                        key={model}
                        type="button"
                        onClick={() => toggleModel(model)}
                        className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 font-mono text-[11px] text-secondary-foreground transition-colors hover:bg-secondary/80"
                      >
                        {model}
                        <span className="text-muted-foreground">×</span>
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{t("providers.testSummary", {
                  total: testItems.length,
                  passed: testItems.filter((item) => item.status === "ok").length,
                  failed: testItems.filter((item) => item.status === "error").length,
                  pending: testItems.filter((item) => item.status === "pending" || item.status === "running").length,
                })}</span>
              </div>

              <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-0.5">
                {testItems.map((item) => {
                  const open = expandedModel === item.model;
                  return (
                    <div key={item.model} className="overflow-hidden rounded-md border border-border/60">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-secondary/40"
                        onClick={() => setExpandedModel(open ? null : item.model)}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.model}</span>
                        <ModelTestStatusBadge item={item} t={t} />
                        {item.result?.latency_ms != null && (item.status === "ok" || item.status === "error") ? (
                          <span className="tabular-nums text-[11px] text-muted-foreground">{item.result.latency_ms} ms</span>
                        ) : null}
                      </button>
                      {open ? (
                        <div className="space-y-2 border-t border-border/50 px-3 py-3">
                          {item.status === "running" || item.status === "pending" ? (
                            <p className="text-[11px] text-muted-foreground">
                              {item.status === "running" ? t("providers.testRunningItem") : t("providers.testPendingItem")}
                            </p>
                          ) : null}
                          {item.error ? (
                            <div className="rounded-md bg-destructive/8 px-3 py-2.5">
                              <p className="text-[11px] text-destructive">{t("providers.testError")}</p>
                              <p className="mt-1 break-words font-mono text-[11px] leading-5">{item.error}</p>
                            </div>
                          ) : null}
                          {item.result ? (
                            <>
                              <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/40 px-3 py-2.5">
                                <div className="min-w-0">
                                  <p className="text-[11px] text-muted-foreground">{t("providers.testStatus")}</p>
                                  <p className="truncate text-sm font-medium">
                                    {item.result.ok ? t("providers.testPassed") : t("providers.testFailed")}
                                  </p>
                                </div>
                                <Badge variant={item.result.ok ? "success" : "destructive"}>
                                  {item.result.status_code ?? "—"}
                                </Badge>
                              </div>
                              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                                <TestStat
                                  label={t("providers.testAttempts")}
                                  value={t("providers.testAttemptsValue", {
                                    attempts: item.result.attempts,
                                    max: item.result.class_max_attempts ?? item.result.max_retries + 1,
                                  })}
                                />
                                <TestStat label={t("providers.testLatency")} value={`${item.result.latency_ms} ms`} />
                                <TestStat label={t("providers.testPath")} value={item.result.path} />
                                {item.result.upstream_model && item.result.upstream_model !== item.result.model ? (
                                  <TestStat label={t("providers.testUpstreamModel")} value={item.result.upstream_model} />
                                ) : null}
                              </div>
                              {!item.result.ok ? (
                                <p className="text-[11px] text-muted-foreground">
                                  {item.result.stop_reason === "normal_budget"
                                    ? t("providers.testStopNormalBudget", {
                                        used: item.result.normal_retries_used ?? 0,
                                        max: item.result.normal_max_retries ?? 0,
                                      })
                                    : item.result.stop_reason === "other_budget"
                                      ? t("providers.testStopOtherBudget", {
                                          used: item.result.other_retries_used ?? 0,
                                          max: item.result.other_max_retries ?? 0,
                                        })
                                      : item.result.stop_reason === "non_retryable"
                                        ? t("providers.testStoppedEarly")
                                        : t("providers.testStopError")}
                                </p>
                              ) : null}
                              {item.result.error ? (
                                <div className="rounded-md bg-destructive/8 px-3 py-2.5">
                                  <p className="text-[11px] text-destructive">{t("providers.testError")}</p>
                                  <p className="mt-1 break-words font-mono text-[11px] leading-5">{item.result.error}</p>
                                </div>
                              ) : null}
                              {item.result.response_preview ? (
                                <div className="rounded-md bg-secondary/40 px-3 py-2.5">
                                  <p className="text-[11px] text-muted-foreground">{t("providers.testResponse")}</p>
                                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                                    {item.result.response_preview}
                                  </pre>
                                </div>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter>
            {testPhase === "results" ? (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={testing}
                  onClick={() => {
                    setTestPhase("select");
                    setTestItems([]);
                    setExpandedModel(null);
                  }}
                >
                  {t("providers.testBack")}
                </Button>
                <Button type="button" disabled={testing} onClick={() => void runSelectedTests()}>
                  {testing ? (
                    <>
                      <LoaderCircle className="animate-spin" data-icon="inline-start" />
                      {t("providers.testRunning")}
                    </>
                  ) : (
                    t("providers.testAgain")
                  )}
                </Button>
                <Button type="button" variant="secondary" disabled={testing} onClick={closeTestDialog}>
                  {t("common.close")}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="secondary" onClick={closeTestDialog}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  disabled={selectedModels.length === 0 || testing}
                  onClick={() => void runSelectedTests()}
                >
                  <FlaskConical data-icon="inline-start" />
                  {selectedModels.length > 1
                    ? t("providers.testRunMany", { n: selectedModels.length })
                    : t("providers.testRunOne")}
                </Button>
              </>
            )}
          </DialogFooter>
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
                    <Button variant="secondary" size="sm" disabled={testing && testProvider?.id === p.id} onClick={() => startTest(p)}>{testing && testProvider?.id === p.id ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <FlaskConical data-icon="inline-start" />}{t("providers.test")}</Button>
                    <Switch checked={p.enabled} onCheckedChange={(v) => toggle.mutate({ id: p.id, enabled: v })} aria-label={`Toggle ${p.name}`} />
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => startEdit(p)} aria-label="Edit"><Pencil className="size-3.5" strokeWidth={1.8} /></Button>
                    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: p.name, description: t("providers.deleteConfirm", { name: p.name }), confirmText: "Delete", destructive: true })) remove.mutate(p.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block">
              <div className={TABLE_HEAD_CLASS}>
                <span className="w-6" />
                <span className="w-36">{t("common.name")}</span><span className="min-w-0 flex-1">{t("providers.baseUrl")}</span><span className="w-16 text-right">{t("providers.keysCol")}</span><span className="w-36">{t("providers.modelsCol")}</span><span className="w-16">{t("common.status")}</span><span className="w-32 text-right">{t("common.actions")}</span>
              </div>
              {data.items.map((p, index) => (
                <div
                  key={p.id}
                  className={`${TABLE_ROW_CLASS} ${dragIndex === index ? "opacity-40" : ""} ${overIndex === index ? "border-t-2 border-t-primary" : ""}`}
                  draggable
                  onDragStart={() => handleDragStart(index, p.id)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                >
                  <span className="flex w-6 cursor-grab items-center text-muted-foreground active:cursor-grabbing" title="拖动排序"><GripVertical className="size-3.5" /></span>
                  <span className="w-36 truncate font-medium">{p.name}</span><span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{p.base_url}</span><span className="w-16 text-right tabular-nums">{p.key_count ?? (p.has_api_key ? 1 : 0)}</span><span className="w-36 truncate text-muted-foreground">{p.models.slice(0, 2).join(", ")}{p.models.length > 2 ? ` +${p.models.length - 2}` : ""}</span><span className="w-16">{p.enabled ? <Badge variant="success">{t("common.active")}</Badge> : <Badge variant="secondary">{t("common.off")}</Badge>}</span>
                  <span className="flex w-32 items-center justify-end gap-1"><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" disabled={testing && testProvider?.id === p.id} onClick={() => startTest(p)} aria-label={t("providers.test")} title={t("providers.test")}>{testing && testProvider?.id === p.id ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}</Button><Switch checked={p.enabled} onCheckedChange={(v) => toggle.mutate({ id: p.id, enabled: v })} aria-label={`Toggle ${p.name}`} /><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={() => startEdit(p)} aria-label="Edit"><Pencil className="size-3.5" strokeWidth={1.8} /></Button><Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: p.name, description: t("providers.deleteConfirm", { name: p.name }), confirmText: "Delete", destructive: true })) remove.mutate(p.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button></span>
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

function ModelTestStatusBadge({
  item,
  t,
}: {
  item: ModelTestItem;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}) {
  if (item.status === "running") {
    return (
      <Badge variant="secondary" className="gap-1">
        <LoaderCircle className="size-3 animate-spin" />
        {t("providers.testRunningItem")}
      </Badge>
    );
  }
  if (item.status === "pending") {
    return <Badge variant="outline">{t("providers.testPendingItem")}</Badge>;
  }
  if (item.status === "ok") {
    return <Badge variant="success">{t("providers.testPassed")}</Badge>;
  }
  return <Badge variant="destructive">{t("providers.testFailed")}</Badge>;
}

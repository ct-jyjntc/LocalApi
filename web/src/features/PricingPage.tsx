import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Brain, ImageIcon, Plus, Trash2 } from "lucide-react";
import { api, type ModelPrice } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { creditsToMicros, formatCredits, formatCreditsInput } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { PriceWindowsEditor, type PriceWindowForm } from "@/features/PriceWindowsEditor";

const emptyForm = {
  model: "",
  input: "0",
  output: "0",
  cacheRead: "0",
  cacheWrite: "0",
  reasoningEnabled: false,
  reasoningEffort: [] as string[],
  imageInput: false,
  contextWindow: "",
  maxOutput: "",
  enabled: true,
  windows: [] as PriceWindowForm[],
};

const EFFORT_OPTIONS: Array<{ value: string; label: string; en: string }> = [
  { value: "minimal", label: "最低", en: "Minimal" },
  { value: "low", label: "低", en: "Low" },
  { value: "medium", label: "中", en: "Medium" },
  { value: "high", label: "高", en: "High" },
  { value: "xhigh", label: "超高", en: "Extra High" },
  { value: "max", label: "最高", en: "Max" },
  { value: "ultra", label: "极限", en: "Ultra" },
];

export function PricingPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const prices = useQuery({ queryKey: ["commercial", "prices"], queryFn: api.commercial.prices.list });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers.list });
  const [form, setForm] = useState(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const models = useMemo(
    () => Array.from(new Set((providers.data?.items ?? []).flatMap((provider) => provider.models).filter((model) => model !== "*"))).sort(),
    [providers.data?.items],
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ["commercial", "prices"] });
  const save = useMutation({
    mutationFn: () => api.commercial.prices.upsert(form.model.trim(), {
      input_price_micros: creditsToMicros(form.input),
      output_price_micros: creditsToMicros(form.output),
      cache_read_price_micros: creditsToMicros(form.cacheRead),
      cache_write_price_micros: creditsToMicros(form.cacheWrite),
      reasoning_enabled: form.reasoningEnabled,
      reasoning_effort: form.reasoningEffort,
      image_input: form.imageInput,
      context_window: form.contextWindow ? Number(form.contextWindow) : 0,
      max_output_tokens: form.maxOutput ? Number(form.maxOutput) : 0,
      enabled: form.enabled,
      windows: form.windows.map((window) => ({
        start: window.start,
        end: window.end,
        days: window.days,
        input_price_micros: creditsToMicros(window.input),
        output_price_micros: creditsToMicros(window.output),
        cache_read_price_micros: creditsToMicros(window.cacheRead),
        cache_write_price_micros: creditsToMicros(window.cacheWrite),
      })),
    }),
    onSuccess: () => { setForm(emptyForm); setFormOpen(false); toast.success(zh ? "模型配置已保存" : "Model config saved"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: api.commercial.prices.remove,
    onSuccess: () => { toast.success(zh ? "配置已删除" : "Config removed"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });

  const edit = (price: ModelPrice) => { setForm({
    model: price.model,
    input: formatCreditsInput(price.input_price_micros),
    output: formatCreditsInput(price.output_price_micros),
    cacheRead: formatCreditsInput(price.cache_read_price_micros),
    cacheWrite: formatCreditsInput(price.cache_write_price_micros),
    reasoningEnabled: price.reasoning_enabled,
    reasoningEffort: price.reasoning_effort,
    imageInput: price.image_input,
    contextWindow: price.context_window ? String(price.context_window) : "",
    maxOutput: price.max_output_tokens ? String(price.max_output_tokens) : "",
    enabled: price.enabled,
    windows: (price.windows ?? []).map((window) => ({
      start: window.start,
      end: window.end === "24:00" ? "23:59" : window.end,
      days: window.days,
      input: formatCreditsInput(window.input_price_micros),
      output: formatCreditsInput(window.output_price_micros),
      cacheRead: formatCreditsInput(window.cache_read_price_micros),
      cacheWrite: formatCreditsInput(window.cache_write_price_micros),
    })),
  }); setFormOpen(true); };

  const toggleEffort = (value: string) => {
    setForm((prev) => ({
      ...prev,
      reasoningEffort: prev.reasoningEffort.includes(value)
        ? prev.reasoningEffort.filter((v) => v !== value)
        : [...prev.reasoningEffort, value],
    }));
  };

  const reasoningLabel = (price: ModelPrice) =>
    price.reasoning_enabled
      ? price.reasoning_effort.length
        ? price.reasoning_effort.join(" / ")
        : (zh ? "默认" : "Default")
      : (zh ? "不支持" : "Off");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "模型配置" : "Model config"} description={zh ? "价格单位为每 100 万 Token 的额度。可配置分时段价（Asia/Shanghai）；未命中时段时使用默认价。推理 Token 默认包含在输出中。" : "Prices are credits per one million tokens. Optional time-of-day windows use Asia/Shanghai; default rates apply when no window matches. Reasoning is included in output by default."} actions={<Button size="sm" onClick={() => { setForm(emptyForm); setFormOpen(true); }}><Plus />{zh ? "新增配置" : "Add config"}</Button>} />
      <Dialog open={formOpen} onOpenChange={setFormOpen}><DialogContent className="max-w-[720px]"><DialogHeader><DialogTitle>{form.model ? (zh ? "编辑模型配置" : "Edit model config") : (zh ? "新增模型配置" : "Add model config")}</DialogTitle><DialogDescription>{zh ? "配置价格与思考参数；思考参数会随 /v1/models 返回给客户端。" : "Prices and reasoning settings; reasoning is exposed via /v1/models."}</DialogDescription></DialogHeader>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={zh ? "模型" : "Model"}>
            <Input list="pricing-models" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            <datalist id="pricing-models">{models.map((model) => <option key={model} value={model} />)}</datalist>
          </Field>
          <Field label={zh ? "普通输入" : "Input"}><Input type="number" step="0.000001" value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} /></Field>
          <Field label={zh ? "输出" : "Output"}><Input type="number" step="0.000001" value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} /></Field>
          <Field label={zh ? "缓存读取" : "Cache read"}><Input type="number" step="0.000001" value={form.cacheRead} onChange={(e) => setForm({ ...form, cacheRead: e.target.value })} /></Field>
          <Field label={zh ? "缓存写入" : "Cache write"}><Input type="number" step="0.000001" value={form.cacheWrite} onChange={(e) => setForm({ ...form, cacheWrite: e.target.value })} /></Field>
          <Field label={zh ? "上下文窗口（Token）" : "Context window (tokens)"}><Input type="number" min="0" step="1000" placeholder="128000" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} /></Field>
          <Field label={zh ? "最大输出（Token）" : "Max output (tokens)"}><Input type="number" min="0" step="100" placeholder="16384" value={form.maxOutput} onChange={(e) => setForm({ ...form, maxOutput: e.target.value })} /></Field>
          <div className="flex items-center justify-between rounded-md bg-secondary/55 px-3 py-2 text-xs"><span className="flex items-center gap-1.5"><Brain className="size-3.5" />{zh ? "支持思考（reasoning_effort）" : "Thinking (reasoning_effort)"}</span><Switch checked={form.reasoningEnabled} onCheckedChange={(reasoningEnabled) => setForm({ ...form, reasoningEnabled, reasoningEffort: reasoningEnabled ? form.reasoningEffort : [] })} /></div>
          <div className="flex items-center justify-between rounded-md bg-secondary/55 px-3 py-2 text-xs"><span className="flex items-center gap-1.5"><ImageIcon className="size-3.5" />{zh ? "支持图像输入（vision）" : "Image input (vision)"}</span><Switch checked={form.imageInput} onCheckedChange={(imageInput) => setForm({ ...form, imageInput })} /></div>
          {form.reasoningEnabled ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label>{zh ? "支持的思考档位（可多选，不选则交上游默认）" : "Supported efforts (multi-select; empty = upstream default)"}</Label>
              <div className="flex gap-2">
                {EFFORT_OPTIONS.map((option) => {
                  const active = form.reasoningEffort.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => toggleEffort(option.value)}
                      className={`h-8 rounded-full border px-4 text-xs transition-colors ${active ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40"}`}
                    >
                      {zh ? option.label : option.en}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between rounded-md bg-secondary/55 px-3 py-2 text-xs sm:col-span-2"><span>{zh ? "向用户开放此模型" : "Make this model available"}</span><Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} /></div>
          <PriceWindowsEditor
            windows={form.windows}
            onChange={(windows) => setForm({ ...form, windows })}
            zh={zh}
            base={{ input: form.input, output: form.output, cacheRead: form.cacheRead, cacheWrite: form.cacheWrite }}
          />
        </div><DialogFooter><Button variant="secondary" onClick={() => setFormOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button disabled={!form.model.trim() || save.isPending} onClick={() => save.mutate()}>{zh ? "保存" : "Save"}</Button></DialogFooter>
      </DialogContent></Dialog>
      <Card className="overflow-hidden">
        {!prices.data?.items.length ? <EmptyState>{prices.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无配置" : "No configs"}</EmptyState> : prices.data.items.map((price) => (
          <div key={price.model}>
            <div className="space-y-2.5 border-b border-border/40 p-3 text-xs md:hidden">
              <div className="flex min-w-0 items-center justify-between gap-2"><button className="min-w-0 flex-1 break-all text-left font-mono" onClick={() => edit(price)}>{price.model}</button><div className="flex shrink-0 items-center gap-1">{price.windows?.length ? <Badge variant="secondary">{zh ? `${price.windows.length} 时段` : `${price.windows.length}`}</Badge> : null}<Badge variant={price.enabled ? "success" : "secondary"}>{price.enabled ? (zh ? "启用" : "Active") : (zh ? "关闭" : "Off")}</Badge></div></div>
              <div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 text-[11px]">
                <PriceStat label={zh ? "输入" : "Input"} value={formatCredits(price.input_price_micros)} /><PriceStat label={zh ? "输出" : "Output"} value={formatCredits(price.output_price_micros)} /><PriceStat label={zh ? "缓存读" : "Cache read"} value={formatCredits(price.cache_read_price_micros)} /><PriceStat label={zh ? "缓存写" : "Cache write"} value={formatCredits(price.cache_write_price_micros)} />
                <PriceStat label={zh ? "上下文" : "Context"} value={formatTokens(price.context_window)} /><PriceStat label={zh ? "最大输出" : "Max output"} value={formatTokens(price.max_output_tokens)} />
                <div className="col-span-2 flex items-center gap-4 rounded-md bg-background/60 px-2 py-1.5"><span className="flex min-w-0 items-center gap-1.5"><Brain className="size-3 shrink-0 text-muted-foreground" /><span className="text-muted-foreground">{zh ? "思考" : "Thinking"}:</span><span className={price.reasoning_enabled ? "text-foreground" : "text-muted-foreground/60"}>{reasoningLabel(price)}</span></span><span className="flex items-center gap-1.5"><ImageIcon className={`size-3 shrink-0 ${price.image_input ? "text-foreground" : "text-muted-foreground/50"}`} /><span className={price.image_input ? "text-foreground" : "text-muted-foreground/60"}>{price.image_input ? (zh ? "图像" : "Image") : (zh ? "无" : "No")}</span></span></div>
              </div>
              <div className="flex justify-end gap-1"><Button variant="secondary" size="sm" onClick={() => edit(price)}>{zh ? "编辑" : "Edit"}</Button><Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => remove.mutate(price.model)}><Trash2 /></Button></div>
            </div>
          </div>
        ))}
        {prices.data?.items.length ? <div className="hidden md:block"><div className={TABLE_HEAD_CLASS}><span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span><span className="w-20 shrink-0 text-right">{zh ? "输入" : "Input"}</span><span className="w-20 shrink-0 text-right">{zh ? "输出" : "Output"}</span><span className="w-20 shrink-0 text-right">{zh ? "缓存读" : "Cache read"}</span><span className="w-20 shrink-0 text-right">{zh ? "缓存写" : "Cache write"}</span><span className="w-16 shrink-0 text-right">{zh ? "上下文" : "Context"}</span><span className="w-16 shrink-0 text-right">{zh ? "最大输出" : "Max out"}</span><span className="w-12 shrink-0 text-right">{zh ? "图像" : "Image"}</span><span className="w-24 shrink-0 text-right">{zh ? "思考" : "Thinking"}</span><span className="w-20 shrink-0 text-right">{zh ? "操作" : "Actions"}</span></div>{prices.data.items.map((price) => <div className={TABLE_ROW_CLASS} key={price.model}><span className="flex min-w-0 flex-1 items-center gap-1.5"><button className="min-w-0 truncate text-left font-mono" onClick={() => edit(price)}>{price.model}</button>{price.windows?.length ? <Badge variant="secondary">{zh ? `${price.windows.length} 时段` : `${price.windows.length}`}</Badge> : null}</span><span className="w-20 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.input_price_micros)}</span><span className="w-20 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.output_price_micros)}</span><span className="w-20 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.cache_read_price_micros)}</span><span className="w-20 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.cache_write_price_micros)}</span><span className="w-16 shrink-0 text-right font-mono tabular-nums">{formatTokens(price.context_window)}</span><span className="w-16 shrink-0 text-right font-mono tabular-nums">{formatTokens(price.max_output_tokens)}</span><span className="flex w-12 shrink-0 items-center justify-end"><ImageIcon className={`size-3.5 ${price.image_input ? "text-foreground" : "text-muted-foreground/40"}`} /></span><span className="flex min-w-0 w-24 shrink-0 items-center justify-end gap-1.5 text-xs" title={reasoningLabel(price)}><Brain className={`size-3 shrink-0 ${price.reasoning_enabled ? "text-foreground" : "text-muted-foreground/50"}`} /><span className={`truncate ${price.reasoning_enabled ? "" : "text-muted-foreground/60"}`}>{reasoningLabel(price)}</span></span><span className="flex w-20 shrink-0 items-center justify-end gap-1"><Badge variant={price.enabled ? "success" : "secondary"}>{price.enabled ? (zh ? "启用" : "Active") : (zh ? "关闭" : "Off")}</Badge><Button variant="ghost" size="icon" className="size-6" onClick={() => remove.mutate(price.model)}><Trash2 /></Button></span></div>)}</div> : null}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5"><Label>{label}</Label>{children}</label>;
}

function formatTokens(tokens: number): string {
  if (!tokens) return "-";
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(tokens);
}

function PriceStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className="mt-1 break-all font-mono tabular-nums text-foreground">{value}</p></div>;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { api, type ModelPrice } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { creditsToMicros, formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

const emptyForm = { model: "", input: "0", output: "0", cacheRead: "0", cacheWrite: "0", enabled: true };

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
      enabled: form.enabled,
    }),
    onSuccess: () => { setForm(emptyForm); setFormOpen(false); toast.success(zh ? "模型价格已保存" : "Model price saved"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: api.commercial.prices.remove,
    onSuccess: () => { toast.success(zh ? "价格已删除" : "Price removed"); refresh(); },
    onError: (error: Error) => toast.error(error.message),
  });

  const edit = (price: ModelPrice) => { setForm({
    model: price.model,
    input: formatCredits(price.input_price_micros),
    output: formatCredits(price.output_price_micros),
    cacheRead: formatCredits(price.cache_read_price_micros),
    cacheWrite: formatCredits(price.cache_write_price_micros),
    enabled: price.enabled,
  }); setFormOpen(true); };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={zh ? "模型价格" : "Model pricing"} description={zh ? "价格单位为每 100 万 Token 的额度；推理 Token 默认包含在输出中。" : "Prices are credits per one million tokens; reasoning is included in output by default."} actions={<Button size="sm" onClick={() => { setForm(emptyForm); setFormOpen(true); }}><Plus />{zh ? "新增价格" : "Add price"}</Button>} />
      <Dialog open={formOpen} onOpenChange={setFormOpen}><DialogContent className="max-w-[640px]"><DialogHeader><DialogTitle>{form.model ? (zh ? "编辑模型价格" : "Edit model pricing") : (zh ? "新增模型价格" : "Add model pricing")}</DialogTitle><DialogDescription>{zh ? "价格单位为每 100 万 Token 的账户额度。" : "Prices are account credits per one million tokens."}</DialogDescription></DialogHeader>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={zh ? "模型" : "Model"}>
            <Input list="pricing-models" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            <datalist id="pricing-models">{models.map((model) => <option key={model} value={model} />)}</datalist>
          </Field>
          <Field label={zh ? "普通输入" : "Input"}><Input type="number" step="0.000001" value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} /></Field>
          <Field label={zh ? "输出" : "Output"}><Input type="number" step="0.000001" value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} /></Field>
          <Field label={zh ? "缓存读取" : "Cache read"}><Input type="number" step="0.000001" value={form.cacheRead} onChange={(e) => setForm({ ...form, cacheRead: e.target.value })} /></Field>
          <Field label={zh ? "缓存写入" : "Cache write"}><Input type="number" step="0.000001" value={form.cacheWrite} onChange={(e) => setForm({ ...form, cacheWrite: e.target.value })} /></Field>
          <div className="flex items-center justify-between rounded-md bg-secondary/55 px-3 py-2 text-xs sm:col-span-2"><span>{zh ? "向用户开放此模型" : "Make this model available"}</span><Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} /></div>
        </div><DialogFooter><Button variant="secondary" onClick={() => setFormOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button disabled={!form.model.trim() || save.isPending} onClick={() => save.mutate()}>{zh ? "保存" : "Save"}</Button></DialogFooter>
      </DialogContent></Dialog>
      <Card className="overflow-hidden">
        {!prices.data?.items.length ? <EmptyState>{prices.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无价格" : "No prices"}</EmptyState> : prices.data.items.map((price) => (
          <div key={price.model}>
            <div className="space-y-2.5 border-b border-border/40 p-3 text-xs md:hidden">
              <div className="flex min-w-0 items-center justify-between gap-2"><button className="min-w-0 flex-1 break-all text-left font-mono" onClick={() => edit(price)}>{price.model}</button><Badge variant={price.enabled ? "success" : "secondary"}>{price.enabled ? (zh ? "启用" : "Active") : (zh ? "关闭" : "Off")}</Badge></div>
              <div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 text-[11px]">
                <PriceStat label={zh ? "输入" : "Input"} value={formatCredits(price.input_price_micros)} /><PriceStat label={zh ? "输出" : "Output"} value={formatCredits(price.output_price_micros)} /><PriceStat label={zh ? "缓存读" : "Cache read"} value={formatCredits(price.cache_read_price_micros)} /><PriceStat label={zh ? "缓存写" : "Cache write"} value={formatCredits(price.cache_write_price_micros)} />
              </div>
              <div className="flex justify-end gap-1"><Button variant="secondary" size="sm" onClick={() => edit(price)}>{zh ? "编辑" : "Edit"}</Button><Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => remove.mutate(price.model)}><Trash2 /></Button></div>
            </div>
          </div>
        ))}
        {prices.data?.items.length ? <div className="hidden md:block"><div className={TABLE_HEAD_CLASS}><span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span><span className="w-24 shrink-0 text-right">{zh ? "输入" : "Input"}</span><span className="w-24 shrink-0 text-right">{zh ? "输出" : "Output"}</span><span className="w-24 shrink-0 text-right">{zh ? "缓存读" : "Cache read"}</span><span className="w-24 shrink-0 text-right">{zh ? "缓存写" : "Cache write"}</span><span className="w-24 shrink-0 text-right">{zh ? "操作" : "Actions"}</span></div>{prices.data.items.map((price) => <div className={TABLE_ROW_CLASS} key={price.model}><button className="min-w-0 flex-1 truncate text-left font-mono" onClick={() => edit(price)}>{price.model}</button><span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.input_price_micros)}</span><span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.output_price_micros)}</span><span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.cache_read_price_micros)}</span><span className="w-24 shrink-0 text-right font-mono tabular-nums">{formatCredits(price.cache_write_price_micros)}</span><span className="flex w-24 shrink-0 items-center justify-end gap-1"><Badge variant={price.enabled ? "success" : "secondary"}>{price.enabled ? (zh ? "启用" : "Active") : (zh ? "关闭" : "Off")}</Badge><Button variant="ghost" size="icon" className="size-6" onClick={() => remove.mutate(price.model)}><Trash2 /></Button></span></div>)}</div> : null}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5"><Label>{label}</Label>{children}</label>;
}

function PriceStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className="mt-1 break-all font-mono tabular-nums text-foreground">{value}</p></div>;
}

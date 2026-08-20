import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers, Search } from "lucide-react";
import { userApi, type ModelPrice, type PriceWindow } from "@/lib/api";
import { EmptyState, EntryIcon, PageHeader, SectionHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserModelsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ModelPrice | null>(null);
  const me = useQuery({ queryKey: ["user", "me"], queryFn: userApi.me });
  const prices = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (me.data?.prices || [])
      .filter((price) => price.enabled && (!query || price.model.toLowerCase().includes(query)))
      .sort((a, b) => a.model.localeCompare(b.model));
  }, [me.data?.prices, search]);

  const groups = useMemo(() => {
    const reasoning = prices.filter((price) => price.reasoning_enabled);
    const vision = prices.filter((price) => !price.reasoning_enabled && price.image_input);
    const general = prices.filter((price) => !price.reasoning_enabled && !price.image_input);
    return [
      { key: "reasoning", title: zh ? "深度思考" : "Reasoning", hint: zh ? "支持 reasoning_effort 思考强度调节的模型" : "Models with adjustable reasoning effort", items: reasoning },
      { key: "vision", title: zh ? "多模态" : "Multimodal", hint: zh ? "支持图片输入的模型" : "Models with image input", items: vision },
      { key: "general", title: zh ? "通用模型" : "General", hint: zh ? "面向通用文本任务" : "General-purpose text models", items: general },
    ].filter((group) => group.items.length > 0);
  }, [prices, zh]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "模型广场" : "Model catalog"}
        description={
          zh
            ? "查看当前已开放模型、思考强度、是否支持图片，以及每 100 万 Token 的计费价格。"
            : "Browse available models, thinking levels, image support, and prices per one million tokens."
        }
      />
      <div className="relative w-full sm:max-w-[320px]">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.8} />
        <Input className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={zh ? "搜索模型" : "Search models"} />
      </div>

      <section className="flex flex-col gap-5">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <SectionHeader title={group.title} hint={group.hint} />
            <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
              {group.items.map((price) => (
                <ModelEntry key={price.model} price={price} zh={zh} onSelect={() => setSelected(price)} />
              ))}
            </div>
          </div>
        ))}
        {!prices.length ? (
          <EmptyState>
            {me.isLoading ? (zh ? "加载中…" : "Loading…") : search ? (zh ? "没有匹配的模型" : "No matching models") : (zh ? "暂无开放模型" : "No models available")}
          </EmptyState>
        ) : null}
      </section>

      <p className="text-[11px] leading-5 text-muted-foreground">
        {zh
          ? "价格单位为账户额度 / 100 万 Token。实际费用按请求发起时的时段价计算；推理 Token 默认计入输出。时区 Asia/Shanghai。"
          : "Prices are account credits per 1M tokens. Charges use the window in effect when the request starts; reasoning tokens are included in output by default. Timezone Asia/Shanghai."}
      </p>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-[480px]">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle className="break-all font-mono text-sm">{selected.model}</DialogTitle>
                <DialogDescription>
                  {zh ? "每 100 万 Token 的额度价格与能力明细。" : "Credit prices per 1M tokens and capability details."}
                </DialogDescription>
              </DialogHeader>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {selected.reasoning_enabled ? <Badge variant="default">{zh ? "思考" : "Thinking"}</Badge> : null}
                {selected.image_input ? <Badge variant="secondary">{zh ? "图片" : "Image"}</Badge> : null}
                {selected.windows?.length ? <Badge variant="secondary">{zh ? `${selected.windows.length} 时段价` : `${selected.windows.length} windows`}</Badge> : null}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-3 text-[11px]">
                <DetailStat label={zh ? "输入" : "Input"} value={formatCredits(selected.input_price_micros)} />
                <DetailStat label={zh ? "输出" : "Output"} value={formatCredits(selected.output_price_micros)} />
                <DetailStat label={zh ? "缓存读取" : "Cache read"} value={formatCredits(selected.cache_read_price_micros)} />
                <DetailStat label={zh ? "缓存写入" : "Cache write"} value={formatCredits(selected.cache_write_price_micros)} />
                <DetailStat label={zh ? "上下文窗口" : "Context window"} value={selected.context_window ? formatContext(selected.context_window) : "-"} />
                <DetailStat label={zh ? "最大输出" : "Max output"} value={selected.max_output_tokens ? formatContext(selected.max_output_tokens) : "-"} />
                <DetailStat label={zh ? "思考强度" : "Thinking effort"} value={thinkingLabel(selected, zh)} />
                <DetailStat label={zh ? "图片输入" : "Image input"} value={selected.image_input ? (zh ? "支持" : "Yes") : (zh ? "不支持" : "No")} />
              </div>
              {selected.windows?.length ? (
                <div className="mt-3">
                  <p className="text-xs font-medium">{zh ? "时段价" : "Time windows"}</p>
                  <div className="mt-1.5 flex flex-col divide-y divide-border/40 rounded-md border border-border/60 text-[11px]">
                    {selected.windows.map((window, index) => (
                      <div key={index} className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="shrink-0 font-mono tabular-nums">
                          {formatWindow(window, zh)}
                          {selected.active_window_index === index ? (
                            <span className="ml-1.5 text-foreground">{zh ? "· 当前" : "· now"}</span>
                          ) : null}
                        </span>
                        <span className="min-w-0 text-right font-mono tabular-nums text-muted-foreground">
                          {`${formatCredits(window.input_price_micros)} / ${formatCredits(window.output_price_micros)} / ${zh ? "读" : "R"} ${formatCredits(window.cache_read_price_micros)} / ${zh ? "写" : "W"} ${formatCredits(window.cache_write_price_micros)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {zh ? "时段价格式：输入 / 输出 / 缓存读 / 缓存写。" : "Window price format: input / output / cache read / cache write."}
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className="mt-1 break-all font-mono tabular-nums text-foreground">{value}</p></div>;
}

function ModelEntry({ price, zh, onSelect }: { price: ModelPrice; zh: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className="flex items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-secondary/40" title={scheduleTitle(price, zh)}>
      <EntryIcon icon={Layers} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate font-mono text-xs font-medium" title={price.model}>{price.model}</p>
          {price.reasoning_enabled ? <Badge variant="default">{zh ? "思考" : "Thinking"}</Badge> : null}
          {price.image_input ? <Badge variant="secondary">{zh ? "图片" : "Image"}</Badge> : null}
        </div>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">{modelSummary(price, zh)}</p>
      </div>
    </button>
  );
}

function modelSummary(price: ModelPrice, zh: boolean) {
  const context = price.context_window ? formatContext(price.context_window) : null;
  const pricePart = `${zh ? "输入" : "in"} ${formatCredits(price.input_price_micros)} / ${zh ? "输出" : "out"} ${formatCredits(price.output_price_micros)}`;
  return context
    ? `${zh ? `上下文 ${context}` : `${context} context`} · ${pricePart}`
    : pricePart;
}

function formatContext(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

const DAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

function formatWindow(window: PriceWindow, zh: boolean) {
  const days = !window.days.length || window.days.length === 7
    ? (zh ? "每天" : "daily")
    : window.days.map((day) => (zh ? DAY_ZH[day] : "SMTWTFS"[day])).join("");
  return `${window.start}–${window.end} ${days}`;
}

function scheduleTitle(price: ModelPrice, zh: boolean) {
  const thinking = zh ? `思考：${thinkingLabel(price, true)}` : `Thinking: ${thinkingLabel(price, false)}`;
  if (!price.windows?.length) return thinking;
  const schedule = price.windows.map((window, index) => {
    const mark = price.active_window_index === index ? (zh ? "当前 " : "now ") : "";
    return `${mark}${formatWindow(window, zh)} ${formatCredits(window.input_price_micros)}/${formatCredits(window.output_price_micros)}`;
  }).join(" · ");
  return `${thinking}\n${schedule}`;
}

function thinkingLabel(price: ModelPrice, zh: boolean) {
  if (!price.reasoning_enabled) return zh ? "不支持" : "No";
  const efforts = (price.reasoning_effort || []).map((item) => item.trim()).filter(Boolean);
  return efforts.length ? efforts.join(" / ") : zh ? "支持（未限定强度）" : "On (any)";
}

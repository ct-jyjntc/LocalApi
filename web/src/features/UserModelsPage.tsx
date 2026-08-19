import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers, Search } from "lucide-react";
import { userApi, type ModelPrice, type PriceWindow } from "@/lib/api";
import { EmptyState, EntryIcon, PageHeader, SectionHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserModelsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [search, setSearch] = useState("");
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
                <ModelEntry key={price.model} price={price} zh={zh} />
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
    </div>
  );
}

function ModelEntry({ price, zh }: { price: ModelPrice; zh: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-secondary/40" title={scheduleTitle(price, zh)}>
      <EntryIcon icon={Layers} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate font-mono text-xs font-medium" title={price.model}>{price.model}</p>
          {price.reasoning_enabled ? <Badge variant="default">{zh ? "思考" : "Thinking"}</Badge> : null}
          {price.image_input ? <Badge variant="secondary">{zh ? "图片" : "Image"}</Badge> : null}
        </div>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">{modelSummary(price, zh)}</p>
      </div>
    </div>
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

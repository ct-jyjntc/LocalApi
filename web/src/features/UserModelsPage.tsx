import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { userApi, type ModelPrice, type PriceWindow } from "@/lib/api";
import { EmptyState, PageHeader } from "@/components/shared";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

const GRID =
  "grid grid-cols-[minmax(10rem,1.5fr)_3rem_minmax(12.5rem,1.2fr)_4.75rem_4.75rem_4.75rem_4.75rem] items-center gap-x-3";

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
      <Card className="overflow-hidden">
        <div className="hidden overflow-x-auto md:block">
          <div className="min-w-[760px]">
            <div className={`${GRID} border-b border-border/60 px-3 py-2 text-xs text-muted-foreground`}>
              <span>{zh ? "模型" : "Model"}</span>
              <span>{zh ? "图片" : "Image"}</span>
              <span>{zh ? "思考" : "Thinking"}</span>
              <span className="text-right">{zh ? "输入" : "Input"}</span>
              <span className="text-right">{zh ? "输出" : "Output"}</span>
              <span className="text-right">{zh ? "缓存读" : "Cache R"}</span>
              <span className="text-right">{zh ? "缓存写" : "Cache W"}</span>
            </div>
            {prices.map((price) => (
              <div className={`${GRID} border-b border-border/40 px-3 py-2 text-xs hover:bg-secondary/40`} key={price.model} title={scheduleTitle(price, zh)}>
                <span className="min-w-0 truncate font-mono" title={price.model}>{price.model}</span>
                <span>{price.image_input ? (zh ? "是" : "Yes") : "—"}</span>
                <span className="whitespace-normal break-words font-mono text-[11px] leading-4">{thinkingLabel(price, zh)}</span>
                <Price value={price.input_price_micros} />
                <Price value={price.output_price_micros} />
                <Price value={price.cache_read_price_micros} />
                <Price value={price.cache_write_price_micros} />
              </div>
            ))}
          </div>
        </div>
        <div className="divide-y divide-border/40 md:hidden">
          {prices.map((price) => (
            <div key={price.model} className="space-y-2.5 p-3 text-xs">
              <p className="break-all font-mono">{price.model}</p>
              <div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 text-[11px]">
                <div>
                  <p className="text-muted-foreground">{zh ? "图片" : "Image"}</p>
                  <p className="mt-1">{price.image_input ? (zh ? "支持" : "Yes") : (zh ? "不支持" : "No")}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{zh ? "思考" : "Thinking"}</p>
                  <p className="mt-1 break-words font-mono">{thinkingLabel(price, zh)}</p>
                </div>
                <MobilePrice label={zh ? "输入" : "Input"} value={price.input_price_micros} />
                <MobilePrice label={zh ? "输出" : "Output"} value={price.output_price_micros} />
                <MobilePrice label={zh ? "缓存读取" : "Cache read"} value={price.cache_read_price_micros} />
                <MobilePrice label={zh ? "缓存写入" : "Cache write"} value={price.cache_write_price_micros} />
              </div>
              {price.windows?.length ? (
                <p className="text-[11px] leading-5 text-muted-foreground">{scheduleTitle(price, zh)}</p>
              ) : null}
            </div>
          ))}
        </div>
        {!prices.length ? <EmptyState>{me.isLoading ? (zh ? "加载中…" : "Loading…") : search ? (zh ? "没有匹配的模型" : "No matching models") : (zh ? "暂无开放模型" : "No models available")}</EmptyState> : null}
      </Card>
      <p className="text-[11px] leading-5 text-muted-foreground">
        {zh
          ? "价格单位为账户额度 / 100 万 Token。思考列是该模型允许的 reasoning_effort。实际费用按请求发起时的时段价计算；推理 Token 默认计入输出。时区 Asia/Shanghai。"
          : "Prices are account credits per 1M tokens. Thinking lists allowed reasoning_effort values. Charges use the window in effect when the request starts; reasoning tokens are included in output by default. Timezone Asia/Shanghai."}
      </p>
    </div>
  );
}

function Price({ value }: { value: number }) {
  return <span className="text-right font-mono tabular-nums">{formatCredits(value)}</span>;
}

function MobilePrice({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono tabular-nums">{formatCredits(value)}</p>
    </div>
  );
}

function thinkingLabel(price: ModelPrice, zh: boolean) {
  if (!price.reasoning_enabled) return zh ? "不支持" : "No";
  const efforts = (price.reasoning_effort || []).map((item) => item.trim()).filter(Boolean);
  return efforts.length ? efforts.join(" / ") : zh ? "支持（未限定强度）" : "On (any)";
}

const DAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

function formatWindow(window: PriceWindow, zh: boolean) {
  const days = !window.days.length || window.days.length === 7
    ? (zh ? "每天" : "daily")
    : window.days.map((day) => (zh ? DAY_ZH[day] : "SMTWTFS"[day])).join("");
  return `${window.start}–${window.end} ${days}`;
}

function scheduleTitle(price: ModelPrice, zh: boolean) {
  if (!price.windows?.length) return undefined;
  return price.windows.map((window, index) => {
    const mark = price.active_window_index === index ? (zh ? "当前 " : "now ") : "";
    return `${mark}${formatWindow(window, zh)} ${formatCredits(window.input_price_micros)}/${formatCredits(window.output_price_micros)}`;
  }).join(" · ");
}

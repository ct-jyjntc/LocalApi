import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { userApi } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
    return (me.data?.prices || []).filter((price) => price.enabled && (!query || price.model.toLowerCase().includes(query))).sort((a, b) => a.model.localeCompare(b.model));
  }, [me.data?.prices, search]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "模型广场" : "Model catalog"}
        description={zh ? "查看当前已开放模型及每 100 万 Token 的详细计费价格。" : "Browse available models and detailed prices per one million tokens."}
      />
      <div className="relative w-full sm:max-w-[320px]">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.8} />
        <Input className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={zh ? "搜索模型" : "Search models"} />
      </div>
      <Card className="overflow-hidden">
        <div className="hidden md:block">
          <div className={TABLE_HEAD_CLASS}><span className="min-w-0 flex-1">{zh ? "模型" : "Model"}</span><span className="w-28 shrink-0 text-right">{zh ? "输入" : "Input"}</span><span className="w-28 shrink-0 text-right">{zh ? "输出" : "Output"}</span><span className="w-28 shrink-0 text-right">{zh ? "缓存读取" : "Cache read"}</span><span className="w-28 shrink-0 text-right">{zh ? "缓存写入" : "Cache write"}</span></div>
          {prices.map((price) => <div className={TABLE_ROW_CLASS} key={price.model}><span className="min-w-0 flex-1 truncate font-mono">{price.model}</span><Price value={price.input_price_micros} /><Price value={price.output_price_micros} /><Price value={price.cache_read_price_micros} /><Price value={price.cache_write_price_micros} /></div>)}
        </div>
        <div className="divide-y divide-border/40 md:hidden">
          {prices.map((price) => <div key={price.model} className="space-y-2.5 p-3 text-xs"><div className="flex items-center justify-between gap-2"><p className="min-w-0 break-all font-mono">{price.model}</p><Badge variant="success">{zh ? "开放" : "Available"}</Badge></div><div className="grid grid-cols-2 gap-2 rounded-md bg-secondary/35 p-2.5 text-[11px]"><MobilePrice label={zh ? "输入" : "Input"} value={price.input_price_micros} /><MobilePrice label={zh ? "输出" : "Output"} value={price.output_price_micros} /><MobilePrice label={zh ? "缓存读取" : "Cache read"} value={price.cache_read_price_micros} /><MobilePrice label={zh ? "缓存写入" : "Cache write"} value={price.cache_write_price_micros} /></div></div>)}
        </div>
        {!prices.length ? <EmptyState>{me.isLoading ? (zh ? "加载中…" : "Loading…") : search ? (zh ? "没有匹配的模型" : "No matching models") : (zh ? "暂无开放模型" : "No models available")}</EmptyState> : null}
      </Card>
      <p className="text-[11px] leading-5 text-muted-foreground">{zh ? "价格单位为账户额度 / 100 万 Token。实际费用按请求的 Token 用量计算；推理 Token 默认计入输出。" : "Prices are account credits per 1M tokens. Actual charges follow token usage; reasoning tokens are included in output by default."}</p>
    </div>
  );
}

function Price({ value }: { value: number }) { return <span className="w-28 shrink-0 text-right font-mono tabular-nums">{formatCredits(value)}</span>; }
function MobilePrice({ label, value }: { label: string; value: number }) { return <div><p className="text-muted-foreground">{label}</p><p className="mt-1 font-mono tabular-nums">{formatCredits(value)}</p></div>; }

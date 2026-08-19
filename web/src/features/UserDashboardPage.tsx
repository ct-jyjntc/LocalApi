import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesCombined } from "lucide-react";
import { userApi, type ModelTrendPoint, type UsageTrendPoint } from "@/lib/api";
import { MetricCard, PageHeader } from "@/components/shared";
import { AnnouncementBanner } from "@/components/AnnouncementHost";
import { Card } from "@/components/ui/card";
import { cn, formatCredits } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type TrendMetric = "cost" | "requests" | "tokens";

export function UserDashboardPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const query = useQuery({
    queryKey: ["user", "dashboard"],
    queryFn: userApi.dashboard,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
  const data = query.data;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={data?.user.display_name || (zh ? "用户概览" : "Account overview")} description={zh ? "查看余额、套餐与 Token 消耗。" : "Track balance, plan and token usage."} />
      <AnnouncementBanner />
      <section className="grid gap-2 min-[360px]:grid-cols-2 xl:grid-cols-4">
        <MetricCard label={zh ? "可用余额" : "Wallet balance"} value={formatCredits(data?.wallet?.balance_micros)} hint={zh ? `冻结 ${formatCredits(data?.wallet?.reserved_micros)}` : `Reserved ${formatCredits(data?.wallet?.reserved_micros)}`} />
        <MetricCard label={zh ? "套餐余额" : "Plan balance"} value={formatCredits(data?.subscription?.remaining_credits_micros)} hint={data?.subscription ? `${data.subscription.plan.name} · ${new Date(data.subscription.period_end).toLocaleDateString()}` : (zh ? "未分配套餐" : "No active plan")} />
        <MetricCard label={zh ? "累计消费" : "Usage cost"} value={formatCredits(data?.totals.cost_micros)} hint={zh ? `${data?.totals.requests || 0} 次请求` : `${data?.totals.requests || 0} requests`} />
        <MetricCard label={zh ? "输入 / 输出 Token" : "Input / output tokens"} value={`${(data?.totals.prompt_tokens || 0).toLocaleString()} / ${(data?.totals.completion_tokens || 0).toLocaleString()}`} hint={zh ? `缓存 ${(data?.totals.cached_tokens || 0).toLocaleString()}` : `Cached ${(data?.totals.cached_tokens || 0).toLocaleString()}`} />
      </section>
      <UsageTrendChart data={data?.trend ?? []} trendByModel={data?.trendByModel ?? []} zh={zh} loading={query.isLoading} />
    </div>
  );
}

function UsageTrendChart({ data, trendByModel, zh, loading }: { data: UsageTrendPoint[]; trendByModel: ModelTrendPoint[]; zh: boolean; loading: boolean }) {
  const [metric, setMetric] = useState<TrendMetric>("cost");
  const [model, setModel] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const models = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of trendByModel) totals.set(row.model, (totals.get(row.model) || 0) + row.requests);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [trendByModel]);
  const activeModel = model && models.includes(model) ? model : null;

  // Per-model rows only exist on days with traffic — re-aggregate by date and
  // zero-fill against the canonical 30-day date list from `data`.
  const rows = useMemo<UsageTrendPoint[]>(() => {
    if (!activeModel) return data;
    const dates = data.length ? data.map((row) => row.date) : last30Dates();
    const byDate = new Map<string, UsageTrendPoint>();
    for (const row of trendByModel) {
      if (row.model !== activeModel) continue;
      const cur = byDate.get(row.date) || { date: row.date, requests: 0, cost_micros: 0, total_tokens: 0 };
      cur.requests += row.requests;
      cur.cost_micros += row.cost_micros;
      cur.total_tokens += row.total_tokens;
      byDate.set(row.date, cur);
    }
    return dates.map((date) => byDate.get(date) || { date, requests: 0, cost_micros: 0, total_tokens: 0 });
  }, [data, trendByModel, activeModel]);
  const definition = {
    cost: { label: zh ? "消费金额" : "Cost", value: (row: UsageTrendPoint) => row.cost_micros / 1_000_000, format: (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 6 }) },
    requests: { label: zh ? "请求次数" : "Requests", value: (row: UsageTrendPoint) => row.requests, format: (value: number) => Math.round(value).toLocaleString() },
    tokens: { label: "Token", value: (row: UsageTrendPoint) => row.total_tokens, format: (value: number) => Math.round(value).toLocaleString() },
  }[metric];

  const chart = useMemo(() => {
    const width = 1000;
    const height = 280;
    const left = 54;
    const right = 16;
    const top = 18;
    const bottom = 34;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const values = rows.map(definition.value);
    const maxValue = Math.max(1, ...values);
    const x = (index: number) => left + (rows.length <= 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
    const y = (value: number) => top + plotHeight - (value / maxValue) * plotHeight;
    const points = values.map((value, index) => ({ x: x(index), y: y(value), value }));
    const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
    const area = points.length ? `${line} L${points.at(-1)!.x},${top + plotHeight} L${points[0].x},${top + plotHeight} Z` : "";
    return { width, height, left, right, top, bottom, plotWidth, plotHeight, maxValue, points, line, area };
  }, [rows, definition]);

  const total = rows.reduce((sum, row) => sum + definition.value(row), 0);
  const hasData = rows.some((row) => definition.value(row) > 0);
  const active = hovered === null ? null : rows[hovered];
  const activePoint = hovered === null ? null : chart.points[hovered];
  const xLabels = rows.length ? Array.from(new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])) : [];

  return (
    <Card className="overflow-hidden p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{zh ? "近 30 天趋势" : "Last 30 days"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {definition.label} <span className="ml-1 font-mono tabular-nums text-foreground">{definition.format(total)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {models.length ? (
            <select
              className="h-8 max-w-48 rounded-md border border-input bg-secondary/55 px-3 text-xs outline-none focus:bg-background focus:ring-1 focus:ring-ring"
              value={activeModel ?? ""}
              onChange={(event) => { setModel(event.target.value || null); setHovered(null); }}
              aria-label={zh ? "模型筛选" : "Model filter"}
            >
              <option value="">{zh ? "全部模型" : "All models"}</option>
              {models.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          ) : null}
          <div className="inline-flex h-8 rounded-md bg-muted p-0.5" aria-label={zh ? "图表指标" : "Chart metric"}>
            {(["cost", "requests", "tokens"] as const).map((item) => {
              const label = item === "cost" ? (zh ? "费用" : "Cost") : item === "requests" ? (zh ? "请求" : "Requests") : "Token";
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={metric === item}
                  onClick={() => { setMetric(item); setHovered(null); }}
                  className={cn("rounded-[5px] px-3 text-[11px] text-muted-foreground transition-colors", metric === item && "bg-background text-foreground shadow-sm")}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-4 h-[220px] w-full text-foreground sm:h-[280px]" onMouseLeave={() => setHovered(null)}>
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{zh ? "加载中…" : "Loading…"}</div>
        ) : !hasData ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ChartNoAxesCombined className="size-5" strokeWidth={1.6} />
            <p className="text-xs">{zh ? "暂无用量数据" : "No usage data yet"}</p>
            <p className="text-[11px]">{zh ? "发起一次 API 调用后，这里会显示趋势。" : "Make an API call and the trend will appear here."}</p>
          </div>
        ) : (
          <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`${definition.label} ${zh ? "趋势图" : "trend chart"}`}>
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = chart.top + chart.plotHeight * (1 - ratio);
              return (
                <g key={ratio}>
                  <line x1={chart.left} x2={chart.width - chart.right} y1={y} y2={y} className="stroke-border/70" strokeWidth="1" />
                  <text x={chart.left - 10} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">{formatCompact(chart.maxValue * ratio)}</text>
                </g>
              );
            })}
            {chart.area ? <path d={chart.area} fill="currentColor" opacity="0.07" /> : null}
            {chart.line ? <path d={chart.line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
            {xLabels.map((index) => (
              <text key={index} x={chart.points[index]?.x} y={chart.height - 8} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"} className="fill-muted-foreground text-[10px]">
                {formatDate(rows[index].date, zh)}
              </text>
            ))}
            {active && activePoint ? (
              <g>
                <line x1={activePoint.x} x2={activePoint.x} y1={chart.top} y2={chart.top + chart.plotHeight} className="stroke-muted-foreground/50" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
                <circle cx={activePoint.x} cy={activePoint.y} r="4" fill="currentColor" />
                <g transform={`translate(${Math.min(chart.width - 170, Math.max(chart.left, activePoint.x - 70))}, ${Math.max(4, activePoint.y - 42)})`}>
                  <rect width="140" height="32" rx="6" className="fill-background stroke-border" />
                  <text x="10" y="13" className="fill-muted-foreground text-[9px]">{formatDate(active.date, zh)}</text>
                  <text x="10" y="25" className="fill-foreground text-[10px] font-medium">{definition.format(activePoint.value)}</text>
                </g>
              </g>
            ) : null}
            {rows.map((row, index) => {
              const segment = chart.plotWidth / Math.max(1, rows.length);
              return <rect key={row.date} x={chart.left + index * segment - segment / 2} y={chart.top} width={segment} height={chart.plotHeight} fill="transparent" onMouseEnter={() => setHovered(index)}><title>{`${row.date}: ${definition.format(definition.value(row))}`}</title></rect>;
            })}
          </svg>
        )}
      </div>
    </Card>
  );
}

/** UTC+8 date list for the last 30 days, used only when the trend is empty. */
function last30Dates(): string[] {
  const nowUtc8 = Date.now() + 8 * 3_600_000;
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    days.push(new Date(nowUtc8 - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function formatCompact(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (!Number.isInteger(value)) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString();
}

function formatDate(value: string, zh: boolean) {
  const [, month, day] = value.split("-");
  return zh ? `${Number(month)}/${Number(day)}` : `${month}/${day}`;
}

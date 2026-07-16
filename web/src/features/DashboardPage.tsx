import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  EmptyState,
  MetricCard,
  MethodBadge,
  PageHeader,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from "@/components/shared";
import { Card } from "@/components/ui/card";
import { formatBytes, formatMs, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function DashboardPage() {
  const { t } = useI18n();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.dashboard(),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t("dash.title")} description={t("dash.desc")} />

      {error ? (
        <Card className="p-4 text-xs text-destructive">{t("dash.error")}</Card>
      ) : null}

      <div className="grid gap-2 min-[360px]:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("dash.totalRequests")}
          value={isLoading ? "—" : (data?.totalRequests ?? 0).toLocaleString()}
          hint={t("dash.last24h", { n: data?.last24h ?? 0 })}
        />
        <MetricCard
          label={t("dash.inputTokens")}
          value={isLoading ? "—" : (data?.promptTokens ?? 0).toLocaleString()}
          hint={t("dash.providersKeys", {
            p: data?.providers ?? 0,
            k: data?.keys ?? 0,
          })}
        />
        <MetricCard
          label={t("dash.outputTokens")}
          value={
            isLoading ? "—" : (data?.completionTokens ?? 0).toLocaleString()
          }
          hint={t("dash.errors", { n: data?.errorRequests ?? 0 })}
        />
        <MetricCard
          label={t("dash.reasoningTokens")}
          value={
            isLoading ? "—" : (data?.reasoningTokens ?? 0).toLocaleString()
          }
          hint={`${t("dash.upstreamCacheTokens")} ${(data?.cachedTokens ?? 0).toLocaleString()}`}
        />
      </div>

      <div className="grid gap-2 min-[360px]:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label={t("dash.avgLatency")}
          value={isLoading ? "—" : formatMs(data?.avgLatencyMs ?? 0)}
        />
        <MetricCard
          label={t("dash.requestVolume")}
          value={isLoading ? "—" : formatBytes(data?.requestBytes ?? 0)}
        />
        <MetricCard
          label={t("dash.responseVolume")}
          value={isLoading ? "—" : formatBytes(data?.responseBytes ?? 0)}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-medium">{t("dash.recent")}</h2>
        </div>
        {!data?.recent?.length ? (
          <EmptyState>
            {isLoading ? t("common.loading") : t("dash.noRequests")}
          </EmptyState>
        ) : (
          <>
            <div className="divide-y divide-border/40 sm:hidden">
              {data.recent.map((r) => (
                <div key={r.id} className="space-y-1.5 px-3 py-2.5 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-10 shrink-0"><MethodBadge method={r.method} /></span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{r.path}</span>
                    <span className={r.status_code >= 400 ? "shrink-0 tabular-nums text-destructive" : "shrink-0 tabular-nums"}>{r.status_code}</span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 pl-12 text-[11px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{r.model || "—"}</span>
                    <span className="shrink-0 tabular-nums">{formatMs(r.latency_ms)}</span>
                    <span className="shrink-0">{shortTime(r.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden sm:block">
              <div className={TABLE_HEAD_CLASS}>
                <span className="w-14">{t("common.method")}</span>
                <span className="min-w-0 flex-1">{t("common.path")}</span>
                <span className="w-28">{t("common.model")}</span>
                <span className="w-12 text-right">{t("common.status")}</span>
                <span className="w-14 text-right">{t("common.latency")}</span>
                <span className="w-36 text-right tabular-nums">{t("logs.input")}/{t("logs.output")}/{t("logs.cache")}/{t("logs.reasoning")}</span>
                <span className="w-36 text-right">{t("common.time")}</span>
              </div>
              {data.recent.map((r) => (
                <div key={r.id} className={TABLE_ROW_CLASS}>
                  <span className="w-14"><MethodBadge method={r.method} /></span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{r.path}</span>
                  <span className="w-28 truncate text-muted-foreground">{r.model || "—"}</span>
                  <span className="w-12 text-right tabular-nums">{r.status_code}</span>
                  <span className="w-14 text-right tabular-nums text-muted-foreground">{formatMs(r.latency_ms)}</span>
                  <span className="w-36 text-right tabular-nums text-[11px] text-muted-foreground">{(r.prompt_tokens ?? 0).toLocaleString()}/{(r.completion_tokens ?? 0).toLocaleString()}/{(r.cached_tokens ?? 0).toLocaleString()}/{(r.reasoning_tokens ?? 0).toLocaleString()}</span>
                  <span className="w-36 text-right text-[11px] text-muted-foreground">{shortTime(r.created_at)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

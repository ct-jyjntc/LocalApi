import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type LogRow } from "@/lib/api";
import {
  EmptyState,
  MethodBadge,
  PageHeader,
  TABLE_HEAD_CLASS,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes, formatMs, shortTime, cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useAppDialog } from "@/components/app-dialog-context";

export function LogsPage() {
  const { t } = useI18n();
  const dialogs = useAppDialog();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const logs = useInfiniteQuery({
    queryKey: ["admin", "logs"],
    queryFn: ({ pageParam }) => api.logs.list(200, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((total, page) => total + page.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 4000,
  });
  const items = logs.data?.pages.flatMap((page) => page.items) || [];
  const total = logs.data?.pages[0]?.total || 0;

  const clear = useMutation({
    mutationFn: () => api.logs.clear(),
    onSuccess: (r) => {
      toast.success(t("logs.cleared", { n: r.removed }));
      qc.invalidateQueries({ queryKey: ["admin", "logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("logs.title")}
        description={t("logs.desc")}
        actions={
          <Button
            variant="secondary"
            size="sm"
            className="text-muted-foreground"
            onClick={async () => {
              if (await dialogs.confirm({ title: t("logs.clear"), description: t("logs.clearConfirm"), confirmText: t("logs.clear"), destructive: true })) clear.mutate();
            }}
          >
            {t("logs.clear")}
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <div className={TABLE_HEAD_CLASS}>
          <span className="w-3.5 shrink-0" />
          <span className="w-10 shrink-0">{t("common.method")}</span>
          <span className="min-w-0 flex-1">{t("common.path")} / {t("common.model")}</span>
          <span className="hidden w-28 shrink-0 md:block">{t("logs.user")}</span>
          <span className="hidden w-28 shrink-0 lg:block">{t("logs.channel")}</span>
          <span className="hidden w-44 shrink-0 text-right sm:block">{t("logs.tokens")}</span>
          <span className="w-10 shrink-0 text-right">HTTP</span>
          <span className="hidden w-14 shrink-0 text-right md:block">{t("common.latency")}</span>
          <span className="hidden w-36 shrink-0 text-right xl:block">{t("common.time")}</span>
        </div>
        {!items.length ? (
          <EmptyState>
            {logs.isLoading ? t("common.loading") : t("logs.empty")}
          </EmptyState>
        ) : (
          <div className="divide-y divide-border/40">
            {items.map((log) => {
              const open = Boolean(expanded[log.id]);
              return (
                <LogItem
                  key={log.id}
                  log={log}
                  open={open}
                  onToggle={() => toggle(log.id)}
                />
              );
            })}
          </div>
        )}
        {items.length ? <div className="flex items-center justify-between border-t border-border/50 px-4 py-3 text-[11px] text-muted-foreground"><span>已显示 {items.length} / {total}</span>{logs.hasNextPage ? <Button variant="secondary" size="sm" disabled={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>{logs.isFetchingNextPage ? t("common.loading") : "加载更多"}</Button> : <span>已加载全部</span>}</div> : null}
      </Card>
    </div>
  );
}

function LogItem({
  log,
  open,
  onToggle,
}: {
  log: LogRow;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["admin", "logs", log.id],
    queryFn: () => api.logs.get(log.id),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const fullLog = detail ?? log;
  const inputTok = fullLog.prompt_tokens ?? 0;
  const outputTok = fullLog.completion_tokens ?? 0;
  const cacheTok = fullLog.cached_tokens ?? 0;
  const reasonTok = fullLog.reasoning_tokens ?? 0;
  const totalTok = fullLog.total_tokens ?? inputTok + outputTok;
  const usagePrefix = fullLog.usage_estimated ? "≈" : "";

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/40"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        )}
        <span className="w-10 shrink-0"><MethodBadge method={log.method} /></span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {log.path}
          {log.model ? (
            <span className="hidden text-muted-foreground sm:inline"> · {log.model}</span>
          ) : null}
        </span>

        <span
          className="hidden w-28 shrink-0 truncate text-[11px] text-muted-foreground md:inline"
          title={userTitle(log)}
        >
          {userLabel(log)}
        </span>

        <span className="hidden w-28 shrink-0 truncate text-[11px] text-muted-foreground lg:inline" title={log.provider_name || undefined}>
          {log.provider_name || "—"}
        </span>

        {/* Compact token counts: 输入 / 输出 / 缓存 / 推理 */}
        <span
          className="hidden w-44 shrink-0 items-center justify-end gap-2 tabular-nums text-[11px] text-muted-foreground sm:inline-flex"
          title={`${t("logs.tokenInput")} ${inputTok} · ${t("logs.tokenOutput")} ${outputTok} · ${t("logs.tokenCache")} ${cacheTok} · ${t("logs.tokenReasoning")} ${reasonTok}`}
        >
          <span>{usagePrefix}<Tok n={inputTok} /></span>
          <span className="text-border">/</span>
          <Tok n={outputTok} />
          <span className="text-border">/</span>
          <Tok n={cacheTok} />
          <span className="text-border">/</span>
          <Tok n={reasonTok} />
        </span>

        <span
          className={cn(
            "w-10 shrink-0 text-right tabular-nums",
            log.status_code >= 400 && "text-destructive",
          )}
        >
          {log.status_code}
        </span>
        <span className="hidden w-14 shrink-0 text-right tabular-nums text-muted-foreground md:inline">
          {formatMs(log.latency_ms)}
        </span>
        {log.stream ? <Badge className="hidden sm:inline-flex" variant="outline">{t("logs.stream")}</Badge> : null}
        <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground xl:inline">
          {shortTime(log.created_at)}
        </span>
      </button>

      {/* Mobile: one compact token line */}
      <div className="space-y-1 px-3 pb-2 text-[11px] tabular-nums text-muted-foreground sm:hidden">
        <p className="break-all font-mono text-foreground/80">{log.model || "—"}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{t("logs.user")} {userLabel(log)}</span>
          <span>{t("logs.channel")} {log.provider_name || "—"}</span>
          {log.stream ? <Badge variant="outline">{t("logs.stream")}</Badge> : null}
          <span>{t("logs.input")} {inputTok}</span>
          <span>{t("logs.output")} {outputTok}</span>
          <span>{t("logs.cache")} {cacheTok}</span>
          <span>{t("logs.reasoning")} {reasonTok}</span>
        </div>
      </div>

      {open ? (
        <div className="min-w-0 space-y-3 border-t border-border/30 bg-secondary/20 px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{t("logs.user")} {userLabel(fullLog)}</span>
            {fullLog.username ? (
              <>
                <span>·</span>
                <span className="font-mono">@{fullLog.username}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{fullLog.provider_name || "—"}</span>
            <span>·</span>
            <span>
              {formatBytes(fullLog.request_bytes)} → {formatBytes(fullLog.response_bytes)}
            </span>
            <span>·</span>
            <span className="tabular-nums">
              {fullLog.usage_estimated ? "估算 · " : ""}
              {t("logs.input")} {inputTok}
              {" / "}
              {t("logs.output")} {outputTok}
              {" / "}
              {t("logs.cache")} {cacheTok}
              {" / "}
              {t("logs.reasoning")} {reasonTok}
              {" · "}
              {t("logs.totalTokens")} {totalTok}
            </span>
            {fullLog.api_key_name ? (
              <>
                <span>·</span>
                <span>{t("logs.key")} {fullLog.api_key_name}</span>
              </>
            ) : null}
          </div>

          {fullLog.error ? (
            <DetailBlock label={t("logs.error")} tone="error">
              {fullLog.error}
            </DetailBlock>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <DetailBlock label={t("logs.input")}>
              {detailLoading
                ? t("common.loading")
                : fullLog.input_text?.trim()
                  ? fullLog.input_text
                  : t("logs.noInput")}
            </DetailBlock>
            <DetailBlock label={t("logs.output")}>
              {detailLoading
                ? t("common.loading")
                : fullLog.output_text?.trim()
                  ? fullLog.output_text
                  : t("logs.noOutput")}
            </DetailBlock>
          </div>

          <DetailBlock label={t("logs.reasoning")}>
            {detailLoading
              ? t("common.loading")
              : fullLog.reasoning_text?.trim()
                ? fullLog.reasoning_text
                : t("logs.noReasoning")}
          </DetailBlock>
        </div>
      ) : null}
    </div>
  );
}

function Tok({ n }: { n: number }) {
  return (
    <span className="min-w-[1.5rem] text-right text-foreground/90">
      {Number(n || 0).toLocaleString()}
    </span>
  );
}

function userLabel(log: Pick<LogRow, "user_label" | "display_name" | "username" | "user_id">) {
  return log.user_label || log.display_name || (log.username ? `@${log.username}` : null) || "—";
}

function userTitle(log: Pick<LogRow, "display_name" | "username" | "user_id">) {
  if (log.display_name && log.username) return `${log.display_name} (@${log.username})`;
  if (log.username) return `@${log.username}`;
  if (log.display_name) return log.display_name;
  return log.user_id || undefined;
}

function DetailBlock({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: "error";
}) {
  return (
    <div className="min-w-0 rounded-md bg-card px-3 py-2.5">
      <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </p>
      <div
        className={cn(
          "max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5",
          tone === "error" ? "text-destructive" : "text-foreground/90",
        )}
      >
        {children}
      </div>
    </div>
  );
}

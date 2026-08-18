import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type LogRow } from "@/lib/api";
import {
  EmptyState,
  MethodBadge,
  PageHeader,
  PaginationBar,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCredits, formatMs, shortTime, cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useAppDialog } from "@/components/app-dialog-context";

type LogFilters = {
  q: string;
  status: "all" | "success" | "error";
  method: string;
  stream: "all" | "stream" | "nonstream";
  provider: string;
  model: string;
};

const EMPTY_FILTERS: LogFilters = {
  q: "",
  status: "all",
  method: "",
  stream: "all",
  provider: "",
  model: "",
};

export function LogsPage() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const dialogs = useAppDialog();
  const qc = useQueryClient();
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<LogFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pageSize = 50;

  // Debounce free-text fields a bit so typing doesn't thrash the API.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters(draft);
      setPage(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const logs = useQuery({
    queryKey: ["admin", "logs", filters, page, pageSize],
    queryFn: () =>
      api.logs.list({
        limit: pageSize,
        offset: page * pageSize,
        q: filters.q.trim() || undefined,
        status: filters.status,
        method: filters.method || undefined,
        stream: filters.stream,
        provider: filters.provider.trim() || undefined,
        model: filters.model.trim() || undefined,
      }),
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  const items = logs.data?.items || [];
  const total = logs.data?.total || 0;

  const clear = useMutation({
    mutationFn: () => api.logs.clear(),
    onSuccess: (r) => {
      toast.success(t("logs.cleared", { n: r.removed }));
      qc.invalidateQueries({ queryKey: ["admin", "logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(0);
  };

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
              if (
                await dialogs.confirm({
                  title: t("logs.clear"),
                  description: t("logs.clearConfirm"),
                  confirmText: t("logs.clear"),
                  destructive: true,
                })
              )
                clear.mutate();
            }}
          >
            {t("logs.clear")}
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <div className="space-y-2 border-b border-border/50 p-3">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Input
              value={draft.q}
              onChange={(e) => setDraft((prev) => ({ ...prev, q: e.target.value }))}
              placeholder={t("logs.filterSearch")}
            />
            <Input
              value={draft.model}
              onChange={(e) => setDraft((prev) => ({ ...prev, model: e.target.value }))}
              placeholder={t("logs.filterModel")}
            />
            <Input
              value={draft.provider}
              onChange={(e) => setDraft((prev) => ({ ...prev, provider: e.target.value }))}
              placeholder={t("logs.filterProvider")}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <FilterSelect
              label={t("logs.filterStatus")}
              value={draft.status}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, status: value as LogFilters["status"] }))
              }
              options={[
                { value: "all", label: t("logs.filterAll") },
                { value: "success", label: t("logs.filterSuccess") },
                { value: "error", label: t("logs.filterError") },
              ]}
            />
            <FilterSelect
              label={t("logs.filterMethod")}
              value={draft.method}
              onChange={(value) => setDraft((prev) => ({ ...prev, method: value }))}
              options={[
                { value: "", label: t("logs.filterAll") },
                ...["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m })),
              ]}
            />
            <FilterSelect
              label={t("logs.filterStream")}
              value={draft.stream}
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, stream: value as LogFilters["stream"] }))
              }
              options={[
                { value: "all", label: t("logs.filterAll") },
                { value: "stream", label: t("logs.filterStreamYes") },
                { value: "nonstream", label: t("logs.filterStreamNo") },
              ]}
            />
            <div className="flex items-end">
              <Button type="button" variant="secondary" size="sm" className="h-8 w-full" onClick={resetFilters}>
                {t("logs.filterReset")}
              </Button>
            </div>
          </div>
        </div>

        <div className={`${TABLE_HEAD_CLASS} hidden sm:flex`}>
          <span className="w-10 shrink-0">{t("common.method")}</span>
          <span className="min-w-0 flex-1">
            {t("common.path")} / {t("common.model")}
          </span>
          <span className="hidden w-28 shrink-0 md:block">{t("logs.user")}</span>
          <span className="hidden w-28 shrink-0 lg:block">{t("logs.channel")}</span>
          <span className="hidden w-44 shrink-0 text-right sm:block">{t("logs.tokens")}</span>
          <span className="w-10 shrink-0 text-right">HTTP</span>
          <span className="hidden w-14 shrink-0 text-right md:block">{t("common.latency")}</span>
          <span className="hidden w-16 shrink-0 text-right lg:block">{t("logs.stream")}</span>
          <span className="hidden w-36 shrink-0 text-right xl:block">{t("common.time")}</span>
        </div>

        {!items.length ? (
          <EmptyState>{logs.isLoading ? t("common.loading") : t("logs.empty")}</EmptyState>
        ) : (
          <>
            <div className="divide-y divide-border/40 sm:hidden">
              {items.map((log) => (
                <MobileLogRow key={log.id} log={log} onOpen={() => setSelectedId(log.id)} />
              ))}
            </div>
            <div className="hidden sm:block">
              {items.map((log) => (
                <DesktopLogRow key={log.id} log={log} onOpen={() => setSelectedId(log.id)} />
              ))}
            </div>
          </>
        )}

        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          loading={logs.isFetching}
          zh={zh}
        />
      </Card>

      <LogDetailDialog
        logId={selectedId}
        preview={items.find((item) => item.id === selectedId) || null}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

function DesktopLogRow({ log, onOpen }: { log: LogRow; onOpen: () => void }) {
  const { t } = useI18n();
  const inputTok = log.prompt_tokens ?? 0;
  const outputTok = log.completion_tokens ?? 0;
  const cacheTok = log.cached_tokens ?? 0;
  const reasonTok = log.reasoning_tokens ?? 0;
  const usagePrefix = log.usage_estimated ? "≈" : "";

  return (
    <button type="button" className={cn(TABLE_ROW_CLASS, "cursor-pointer border-0 bg-transparent")} onClick={onOpen}>
      <span className="w-10 shrink-0">
        <MethodBadge method={log.method} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {log.path}
        {log.model ? <span className="text-muted-foreground"> · {log.model}</span> : null}
        {log.error ? (
          <span className="ml-1 truncate text-destructive" title={log.error}>
            · {log.error}
          </span>
        ) : null}
      </span>
      <span className="hidden w-28 shrink-0 truncate text-[11px] text-muted-foreground md:inline" title={userTitle(log)}>
        {userLabel(log)}
      </span>
      <span
        className="hidden w-28 shrink-0 truncate text-[11px] text-muted-foreground lg:inline"
        title={log.provider_name || undefined}
      >
        {log.provider_name || "—"}
      </span>
      <span
        className="hidden w-44 shrink-0 items-center justify-end gap-2 tabular-nums text-[11px] text-muted-foreground sm:inline-flex"
        title={`${t("logs.tokenInput")} ${inputTok} · ${t("logs.tokenOutput")} ${outputTok} · ${t("logs.tokenCache")} ${cacheTok} · ${t("logs.tokenReasoning")} ${reasonTok}`}
      >
        <span>
          {usagePrefix}
          <Tok n={inputTok} />
        </span>
        <span className="text-border">/</span>
        <Tok n={outputTok} />
        <span className="text-border">/</span>
        <Tok n={cacheTok} />
        <span className="text-border">/</span>
        <Tok n={reasonTok} />
      </span>
      <span className={cn("w-10 shrink-0 text-right tabular-nums", log.status_code >= 400 && "text-destructive")}>
        {log.status_code}
      </span>
      <span className="hidden w-14 shrink-0 text-right tabular-nums text-muted-foreground md:inline">
        {formatMs(log.latency_ms)}
      </span>
      <span className="hidden w-16 shrink-0 justify-end lg:inline-flex">
        {log.stream ? <Badge variant="outline">{t("logs.stream")}</Badge> : <span className="text-muted-foreground">—</span>}
      </span>
      <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground xl:inline">
        {shortTime(log.created_at)}
      </span>
    </button>
  );
}

function MobileLogRow({ log, onOpen }: { log: LogRow; onOpen: () => void }) {
  const { t } = useI18n();
  const inputTok = log.prompt_tokens ?? 0;
  const outputTok = log.completion_tokens ?? 0;
  const cacheTok = log.cached_tokens ?? 0;
  const reasonTok = log.reasoning_tokens ?? 0;

  return (
    <button type="button" className="w-full space-y-1.5 border-0 bg-transparent px-3 py-2.5 text-left text-[11px] transition-colors hover:bg-secondary/40" onClick={onOpen}>
      <div className="flex items-center gap-2">
        <MethodBadge method={log.method} />
        <span className={cn("font-mono tabular-nums", log.status_code >= 400 && "text-destructive")}>
          {log.status_code}
        </span>
        <span className="text-muted-foreground">{formatMs(log.latency_ms)}</span>
        {log.stream ? <Badge variant="outline">{t("logs.stream")}</Badge> : null}
        <span className="ml-auto text-muted-foreground">{shortTime(log.created_at)}</span>
      </div>
      <p className="break-all font-mono text-xs text-foreground/90">{log.path}</p>
      <p className="break-all font-mono text-muted-foreground">{log.model || "—"}</p>
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-muted-foreground">
        <span>
          {t("logs.user")} {userLabel(log)}
        </span>
        <span>
          {t("logs.channel")} {log.provider_name || "—"}
        </span>
        <span>
          {t("logs.input")} {inputTok}
        </span>
        <span>
          {t("logs.output")} {outputTok}
        </span>
        <span>
          {t("logs.cache")} {cacheTok}
        </span>
        <span>
          {t("logs.reasoning")} {reasonTok}
        </span>
      </div>
      {log.error ? <p className="break-words text-destructive">{log.error}</p> : null}
    </button>
  );
}

function LogDetailDialog({
  logId,
  preview,
  onClose,
}: {
  logId: string | null;
  preview: LogRow | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const detail = useQuery({
    queryKey: ["admin", "logs", "detail", logId],
    queryFn: () => api.logs.get(logId!),
    enabled: Boolean(logId),
  });
  const log = detail.data ?? preview;
  if (!logId || !log) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <MethodBadge method={log.method} />
            <span className="min-w-0 truncate font-mono text-xs font-normal">{log.path}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">{t("logs.detail")}</DialogDescription>
        </DialogHeader>

        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <Meta label="HTTP" value={String(log.status_code)} danger={log.status_code >= 400} />
          <Meta label={t("common.latency")} value={formatMs(log.latency_ms)} />
          <Meta label={t("common.time")} value={shortTime(log.created_at)} />
          <Meta label={t("logs.stream")} value={log.stream ? t("logs.filterStreamYes") : t("logs.filterStreamNo")} />
          <Meta label={t("common.model")} value={log.model || "—"} mono />
          <Meta label={t("logs.channel")} value={log.provider_name || "—"} />
          <Meta label={t("logs.user")} value={userLabel(log)} />
          <Meta label={t("logs.key")} value={log.api_key_name || "—"} />
          <Meta label={t("logs.tokenInput")} value={fmtTok(log.prompt_tokens, log.usage_estimated)} />
          <Meta label={t("logs.tokenOutput")} value={fmtTok(log.completion_tokens, log.usage_estimated)} />
          <Meta label={t("logs.tokenCache")} value={fmtTok(log.cached_tokens, log.usage_estimated)} />
          <Meta label={t("logs.tokenReasoning")} value={fmtTok(log.reasoning_tokens, log.usage_estimated)} />
          <Meta label={zh ? "费用" : "Cost"} value={formatCredits(log.cost_micros ?? 0)} />
          <Meta label={t("logs.responseCache")} value={log.cached ? t("logs.hit") : t("logs.miss")} />
          <Meta label={zh ? "请求" : "Request"} value={fmtBytes(log.request_bytes)} />
          <Meta label={zh ? "响应" : "Response"} value={fmtBytes(log.response_bytes)} />
        </div>

        {log.error ? (
          <div className="mt-3 space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
            <p className="font-medium">{zh ? "上游错误" : "Upstream error"}</p>
            <p className="whitespace-pre-wrap break-words font-mono">{log.error}</p>
          </div>
        ) : null}

        {detail.isLoading ? (
          <p className="mt-4 text-xs text-muted-foreground">{t("common.loading")}</p>
        ) : (
          <div className="mt-4 space-y-3">
            <TextBlock label={t("logs.input")} empty={t("logs.noInput")} value={detail.data?.input_text} />
            <TextBlock label={t("logs.output")} empty={t("logs.noOutput")} value={detail.data?.output_text} />
            <TextBlock label={t("logs.reasoning")} empty={t("logs.noReasoning")} value={detail.data?.reasoning_text} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Meta({
  label,
  value,
  mono,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md bg-secondary/55 px-2.5 py-2">
      <p className="text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 truncate", mono && "font-mono", danger && "text-destructive")} title={value}>
        {value}
      </p>
    </div>
  );
}

function TextBlock({ label, empty, value }: { label: string; empty: string; value?: string | null }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/55 px-3 py-2.5 font-mono text-[11px] leading-5">
        {value?.trim() ? value : <span className="text-muted-foreground">{empty}</span>}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <select
        className="h-8 w-full min-w-0 rounded-md border border-input bg-secondary/55 px-2 text-xs outline-none focus:bg-background focus:ring-1 focus:ring-ring"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={`${label}-${option.value || "all"}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Tok({ n }: { n: number }) {
  return <span className="min-w-[1.5rem] text-right text-foreground/90">{Number(n || 0).toLocaleString()}</span>;
}

function fmtTok(n: number | undefined, estimated?: boolean) {
  return `${estimated ? "≈" : ""}${Number(n || 0).toLocaleString()}`;
}

function fmtBytes(n: number | undefined) {
  const bytes = Number(n || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

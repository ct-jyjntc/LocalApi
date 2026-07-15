import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type LogRow } from "@/lib/api";
import {
  EmptyState,
  MethodBadge,
  PageHeader,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes, formatMs, shortTime, cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function LogsPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { data, isLoading } = useQuery({
    queryKey: ["logs"],
    queryFn: () => api.logs.list(200),
    refetchInterval: 4000,
  });

  const clear = useMutation({
    mutationFn: () => api.logs.clear(),
    onSuccess: (r) => {
      toast.success(t("logs.cleared", { n: r.removed }));
      qc.invalidateQueries({ queryKey: ["logs"] });
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
            onClick={() => {
              if (confirm(t("logs.clearConfirm"))) clear.mutate();
            }}
          >
            {t("logs.clear")}
          </Button>
        }
      />

      <Card className="overflow-hidden">
        {!data?.items?.length ? (
          <EmptyState>
            {isLoading ? t("common.loading") : t("logs.empty")}
          </EmptyState>
        ) : (
          <div className="divide-y divide-border/40">
            {data.items.map((log) => {
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
  const inputTok = log.prompt_tokens ?? 0;
  const outputTok = log.completion_tokens ?? 0;
  const cacheTok = log.cached_tokens ?? 0;
  const reasonTok = log.reasoning_tokens ?? 0;
  const totalTok = log.total_tokens ?? inputTok + outputTok;

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
        <MethodBadge method={log.method} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {log.path}
          {log.model ? (
            <span className="text-muted-foreground"> · {log.model}</span>
          ) : null}
        </span>

        {/* Compact token counts: 输入 / 输出 / 缓存 / 推理 */}
        <span
          className="hidden shrink-0 items-center gap-2 tabular-nums text-[11px] text-muted-foreground sm:inline-flex"
          title={`${t("logs.tokenInput")} ${inputTok} · ${t("logs.tokenOutput")} ${outputTok} · ${t("logs.tokenCache")} ${cacheTok} · ${t("logs.tokenReasoning")} ${reasonTok}`}
        >
          <Tok n={inputTok} />
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
        {log.stream ? <Badge variant="outline">{t("logs.stream")}</Badge> : null}
        <span className="hidden w-36 shrink-0 text-right text-[11px] text-muted-foreground lg:inline">
          {shortTime(log.created_at)}
        </span>
      </button>

      {/* Mobile: one compact token line */}
      <div className="flex items-center gap-2 px-3 pb-2 text-[11px] tabular-nums text-muted-foreground sm:hidden">
        <span>
          {t("logs.input")} {inputTok}
        </span>
        <span className="text-border">·</span>
        <span>
          {t("logs.output")} {outputTok}
        </span>
        <span className="text-border">·</span>
        <span>
          {t("logs.cache")} {cacheTok}
        </span>
        <span className="text-border">·</span>
        <span>
          {t("logs.reasoning")} {reasonTok}
        </span>
      </div>

      {open ? (
        <div className="space-y-3 border-t border-border/30 bg-secondary/20 px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{log.provider_name || "—"}</span>
            <span>·</span>
            <span>
              {formatBytes(log.request_bytes)} → {formatBytes(log.response_bytes)}
            </span>
            <span>·</span>
            <span className="tabular-nums">
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
            {log.api_key_name ? (
              <>
                <span>·</span>
                <span>{log.api_key_name}</span>
              </>
            ) : null}
          </div>

          {log.error ? (
            <DetailBlock label={t("logs.error")} tone="error">
              {log.error}
            </DetailBlock>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <DetailBlock label={t("logs.input")}>
              {log.input_text?.trim() ? log.input_text : t("logs.noInput")}
            </DetailBlock>
            <DetailBlock label={t("logs.output")}>
              {log.output_text?.trim() ? log.output_text : t("logs.noOutput")}
            </DetailBlock>
          </div>

          <DetailBlock label={t("logs.reasoning")}>
            {log.reasoning_text?.trim()
              ? log.reasoning_text
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

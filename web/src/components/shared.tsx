import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-start justify-between gap-3",
        className,
      )}
    >
      <div>
        <h1 className="text-xl font-medium tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export const TABLE_HEAD_CLASS =
  "flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs font-normal text-muted-foreground";

export const TABLE_ROW_CLASS =
  "flex h-9 w-full items-center gap-2 border-b border-border/40 px-3 text-left text-xs transition-colors hover:bg-secondary/40";

export function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-h-24 min-w-0 rounded-lg bg-card p-3 sm:min-h-28 sm:p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 break-words text-lg font-medium tabular-nums tracking-tight sm:text-xl">
        {value}
      </p>
      {hint ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[200px] flex-1 items-center justify-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** Compact footer for server-paginated lists. */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  loading,
  zh = true,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
  zh?: boolean;
  className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const from = total === 0 ? 0 : safePage * pageSize + 1;
  const to = Math.min(total, (safePage + 1) * pageSize);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span>
        {zh
          ? `显示 ${from}-${to} / 共 ${total} · 第 ${safePage + 1}/${pageCount} 页`
          : `Showing ${from}-${to} of ${total} · page ${safePage + 1}/${pageCount}`}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={safePage <= 0 || loading}
          onClick={() => onPageChange(Math.max(0, safePage - 1))}
          className="h-7 rounded-md border border-border/60 bg-background px-2.5 text-[11px] text-foreground transition-colors hover:bg-secondary/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {zh ? "上一页" : "Prev"}
        </button>
        <button
          type="button"
          disabled={safePage >= pageCount - 1 || loading}
          onClick={() => onPageChange(Math.min(pageCount - 1, safePage + 1))}
          className="h-7 rounded-md border border-border/60 bg-background px-2.5 text-[11px] text-foreground transition-colors hover:bg-secondary/50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {zh ? "下一页" : "Next"}
        </button>
      </div>
    </div>
  );
}

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  const color =
    m === "GET"
      ? "text-success"
      : m === "POST"
        ? "text-sky-600 dark:text-sky-400"
        : m === "DELETE"
          ? "text-destructive"
          : "text-foreground";
  return (
    <span className={`font-mono text-[11px] font-medium tabular-nums ${color}`}>
      {m}
    </span>
  );
}

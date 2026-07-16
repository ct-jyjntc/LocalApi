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

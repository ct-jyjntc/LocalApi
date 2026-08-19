import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { api, type ApiKeyRow } from "@/lib/api";
import {
  EmptyState,
  PageHeader,
  PaginationBar,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { creditsToMicros, formatCreditsInput, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useAppDialog } from "@/components/app-dialog-context";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function KeysPage() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["keys", page, pageSize],
    queryFn: () => api.keys.list({ limit: pageSize, offset: page * pageSize }),
    placeholderData: (prev) => prev,
  });
  const [name, setName] = useState("");
  const [createDaily, setCreateDaily] = useState("");
  const [createMonthly, setCreateMonthly] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKeyRow | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.keys.create({
        name: name.trim() || t("keys.untitled"),
        daily_quota_micros: creditsToMicros(createDaily),
        monthly_quota_micros: creditsToMicros(createMonthly),
      }),
    onSuccess: async (row) => {
      setName("");
      setCreateDaily("");
      setCreateMonthly("");
      setCreateOpen(false);
      if (row.key) {
        try {
          await navigator.clipboard.writeText(row.key);
          toast.success(t("keys.createdCopied"));
        } catch {
          toast.success(t("keys.created"));
        }
      } else {
        toast.success(t("keys.created"));
      }
      qc.invalidateQueries({ queryKey: ["keys"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.keys.update(id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveEdit = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<{ name: string; rate_limit: number; daily_quota_micros: number; monthly_quota_micros: number }> }) =>
      api.keys.update(id, body),
    onSuccess: () => {
      toast.success(t("keys.saved"));
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["keys"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.keys.remove(id),
    onSuccess: () => {
      toast.success(t("keys.deleted"));
      qc.invalidateQueries({ queryKey: ["keys"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("keys.copyFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("keys.title")} description={t("keys.desc")} actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus data-icon="inline-start" />{t("keys.create")}</Button>} />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>{t("keys.create")}</DialogTitle><DialogDescription>{t("keys.desc")}</DialogDescription></DialogHeader><form className="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><label className="flex flex-col gap-1.5"><Label>{t("common.name")}</Label><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="my-app" /></label><div className="grid grid-cols-2 gap-3"><label className="flex flex-col gap-1.5"><Label>{t("keys.dailyQuota")}</Label><Input type="number" min={0} step="0.01" inputMode="decimal" value={createDaily} onChange={(event) => setCreateDaily(event.target.value)} placeholder="0.00" /></label><label className="flex flex-col gap-1.5"><Label>{t("keys.monthlyQuota")}</Label><Input type="number" min={0} step="0.01" inputMode="decimal" value={createMonthly} onChange={(event) => setCreateMonthly(event.target.value)} placeholder="0.00" /></label></div><p className="text-[11px] text-muted-foreground">{t("keys.limitsHint")}</p><DialogFooter className="mt-0"><Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? t("common.loading") : t("common.create")}</Button></DialogFooter></form></DialogContent></Dialog>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}><DialogContent><DialogHeader><DialogTitle>{t("keys.edit")}</DialogTitle><DialogDescription>{t("keys.limitsHint")}</DialogDescription></DialogHeader>{editing ? <EditKeyForm key={editing.id} row={editing} pending={saveEdit.isPending} onCancel={() => setEditing(null)} onSubmit={(body) => saveEdit.mutate({ id: editing.id, body })} /> : null}</DialogContent></Dialog>

      <Card className="overflow-hidden">
        <div className={`${TABLE_HEAD_CLASS} hidden sm:flex`}>
          <span className="w-28 shrink-0">{t("common.name")}</span>
          <span className="w-28 shrink-0">{zh ? "用户" : "User"}</span>
          <span className="min-w-0 flex-1">{t("keys.secret")}</span>
          <span className="w-16 shrink-0">{t("common.status")}</span>
          <span className="hidden w-36 shrink-0 md:block">{t("common.lastUsed")}</span>
          <span className="w-28 shrink-0 text-right">{t("common.actions")}</span>
        </div>
        {!data?.items?.length ? (
          <EmptyState>
            {isLoading ? t("common.loading") : t("keys.empty")}
          </EmptyState>
        ) : (
          data.items.map((k) => <KeyRow key={k.id} row={k} onCopy={copyKey} onToggle={toggle.mutate} onEdit={() => setEditing(k)} onRemove={remove.mutate} />)
        )}
        {data ? (
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={data.total}
            onPageChange={setPage}
            loading={isFetching}
            zh={zh}
          />
        ) : null}
      </Card>
    </div>
  );
}

function EditKeyForm({
  row,
  pending,
  onCancel,
  onSubmit,
}: {
  row: ApiKeyRow;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: Partial<{ name: string; rate_limit: number; daily_quota_micros: number; monthly_quota_micros: number }>) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(row.name);
  const [rpm, setRpm] = useState(row.rate_limit > 0 ? String(row.rate_limit) : "");
  const [daily, setDaily] = useState(row.daily_quota_micros > 0 ? formatCreditsInput(row.daily_quota_micros) : "");
  const [monthly, setMonthly] = useState(row.monthly_quota_micros > 0 ? formatCreditsInput(row.monthly_quota_micros) : "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: Partial<{ name: string; rate_limit: number; daily_quota_micros: number; monthly_quota_micros: number }> = {
      rate_limit: Math.max(0, Math.min(100_000, Math.round(Number(rpm) || 0))),
      daily_quota_micros: creditsToMicros(daily),
      monthly_quota_micros: creditsToMicros(monthly),
    };
    const trimmed = name.trim();
    if (trimmed && trimmed !== row.name) body.name = trimmed;
    onSubmit(body);
  };
  return (
    <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
      <label className="flex flex-col gap-1.5"><Label>{t("common.name")}</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="flex flex-col gap-1.5"><Label>{t("keys.rateLimit")}</Label><Input type="number" min={0} max={100000} inputMode="numeric" value={rpm} onChange={(event) => setRpm(event.target.value)} placeholder="0" /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5"><Label>{t("keys.dailyQuota")}</Label><Input type="number" min={0} step="0.01" inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder="0.00" /></label>
        <label className="flex flex-col gap-1.5"><Label>{t("keys.monthlyQuota")}</Label><Input type="number" min={0} step="0.01" inputMode="decimal" value={monthly} onChange={(event) => setMonthly(event.target.value)} placeholder="0.00" /></label>
      </div>
      <DialogFooter className="mt-0"><Button type="button" variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button><Button type="submit" disabled={pending || !name.trim()}>{pending ? t("common.loading") : t("common.save")}</Button></DialogFooter>
    </form>
  );
}

function KeyRow({
  row,
  onCopy,
  onToggle,
  onEdit,
  onRemove,
}: {
  row: ApiKeyRow;
  onCopy: (key: string) => void;
  onToggle: (v: { id: string; enabled: boolean }) => void;
  onEdit: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const dialogs = useAppDialog();
  const full = row.key || null;
  const display = full || `${row.key_prefix}…`;

  return (
    <>
      <div className="space-y-2 border-b border-border/40 p-3 text-xs sm:hidden">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="min-w-0 truncate font-medium">{row.name}</p>
            {row.user_display_name || row.username ? <p className="truncate text-[11px] text-muted-foreground">@{row.user_display_name || row.username}</p> : null}
          </div>
          {row.enabled ? <Badge variant="success">{t("common.active")}</Badge> : <Badge variant="secondary">{t("common.off")}</Badge>}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 rounded-md bg-secondary/45 px-2.5 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground/90">{display}</code>
          {full ? <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={() => onCopy(full)} aria-label={t("common.copy")} title={t("common.copy")}><Copy className="size-3.5" strokeWidth={1.8} /></Button> : <span className="shrink-0 text-[11px] text-muted-foreground">{t("keys.legacyNoPlain")}</span>}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>{t("common.lastUsed")} {row.last_used_at ? shortTime(row.last_used_at) : "—"}</span>
          <span className="flex items-center gap-1"><Switch checked={row.enabled} onCheckedChange={(v) => onToggle({ id: row.id, enabled: v })} aria-label={`Toggle ${row.name}`} /><Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={onEdit} aria-label="Edit"><Pencil className="size-3.5" strokeWidth={1.8} /></Button><Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: row.name, description: t("keys.deleteConfirm", { name: row.name }), confirmText: "Delete", destructive: true })) onRemove(row.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button></span>
        </div>
      </div>
      <div className={`${TABLE_ROW_CLASS} hidden sm:flex`}>
        <span className="w-28 shrink-0 truncate">{row.name}</span>
        <span className="w-28 shrink-0 truncate text-muted-foreground" title={row.user_display_name || row.username || ""}>{row.user_display_name || row.username || "—"}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5"><code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">{display}</code>{full ? <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground" onClick={() => onCopy(full)} aria-label={t("common.copy")} title={t("common.copy")}><Copy className="size-3.5" strokeWidth={1.8} /></Button> : <span className="shrink-0 text-[11px] text-muted-foreground">{t("keys.legacyNoPlain")}</span>}</span>
        <span className="w-16 shrink-0">{row.enabled ? <Badge variant="success">{t("common.active")}</Badge> : <Badge variant="secondary">{t("common.off")}</Badge>}</span>
        <span className="hidden w-36 shrink-0 text-[11px] text-muted-foreground md:block">{row.last_used_at ? shortTime(row.last_used_at) : "—"}</span>
        <span className="flex w-28 shrink-0 items-center justify-end gap-1"><Switch checked={row.enabled} onCheckedChange={(v) => onToggle({ id: row.id, enabled: v })} aria-label={`Toggle ${row.name}`} /><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={onEdit} aria-label="Edit"><Pencil className="size-3.5" strokeWidth={1.8} /></Button><Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: row.name, description: t("keys.deleteConfirm", { name: row.name }), confirmText: "Delete", destructive: true })) onRemove(row.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button></span>
      </div>
    </>
  );
}

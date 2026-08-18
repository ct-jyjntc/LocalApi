import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Plus, Trash2 } from "lucide-react";
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
import { shortTime } from "@/lib/utils";
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
  const [createOpen, setCreateOpen] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.keys.create({ name: name.trim() || t("keys.untitled") }),
    onSuccess: async (row) => {
      setName("");
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
    <div className="space-y-6">
      <PageHeader title={t("keys.title")} description={t("keys.desc")} actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus data-icon="inline-start" />{t("keys.create")}</Button>} />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>{t("keys.create")}</DialogTitle><DialogDescription>{t("keys.desc")}</DialogDescription></DialogHeader><form className="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><label className="flex flex-col gap-1.5"><Label>{t("common.name")}</Label><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="my-app" /></label><DialogFooter className="mt-0"><Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? t("common.loading") : t("common.create")}</Button></DialogFooter></form></DialogContent></Dialog>

      <Card className="overflow-hidden">
        <div className={`${TABLE_HEAD_CLASS} hidden sm:flex`}>
          <span className="w-28 shrink-0">{t("common.name")}</span>
          <span className="w-28 shrink-0">{zh ? "用户" : "User"}</span>
          <span className="min-w-0 flex-1">{t("keys.secret")}</span>
          <span className="w-16 shrink-0">{t("common.status")}</span>
          <span className="hidden w-36 shrink-0 md:block">{t("common.lastUsed")}</span>
          <span className="w-20 shrink-0 text-right">{t("common.actions")}</span>
        </div>
        {!data?.items?.length ? (
          <EmptyState>
            {isLoading ? t("common.loading") : t("keys.empty")}
          </EmptyState>
        ) : (
          data.items.map((k) => <KeyRow key={k.id} row={k} onCopy={copyKey} onToggle={toggle.mutate} onRemove={remove.mutate} />)
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

function KeyRow({
  row,
  onCopy,
  onToggle,
  onRemove,
}: {
  row: ApiKeyRow;
  onCopy: (key: string) => void;
  onToggle: (v: { id: string; enabled: boolean }) => void;
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
          <span className="flex items-center gap-1"><Switch checked={row.enabled} onCheckedChange={(v) => onToggle({ id: row.id, enabled: v })} aria-label={`Toggle ${row.name}`} /><Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: row.name, description: t("keys.deleteConfirm", { name: row.name }), confirmText: "Delete", destructive: true })) onRemove(row.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button></span>
        </div>
      </div>
      <div className={`${TABLE_ROW_CLASS} hidden sm:flex`}>
        <span className="w-28 shrink-0 truncate">{row.name}</span>
        <span className="w-28 shrink-0 truncate text-muted-foreground" title={row.user_display_name || row.username || ""}>{row.user_display_name || row.username || "—"}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5"><code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">{display}</code>{full ? <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground" onClick={() => onCopy(full)} aria-label={t("common.copy")} title={t("common.copy")}><Copy className="size-3.5" strokeWidth={1.8} /></Button> : <span className="shrink-0 text-[11px] text-muted-foreground">{t("keys.legacyNoPlain")}</span>}</span>
        <span className="w-16 shrink-0">{row.enabled ? <Badge variant="success">{t("common.active")}</Badge> : <Badge variant="secondary">{t("common.off")}</Badge>}</span>
        <span className="hidden w-36 shrink-0 text-[11px] text-muted-foreground md:block">{row.last_used_at ? shortTime(row.last_used_at) : "—"}</span>
        <span className="flex w-20 shrink-0 items-center justify-end gap-1"><Switch checked={row.enabled} onCheckedChange={(v) => onToggle({ id: row.id, enabled: v })} aria-label={`Toggle ${row.name}`} /><Button variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" onClick={async () => { if (await dialogs.confirm({ title: row.name, description: t("keys.deleteConfirm", { name: row.name }), confirmText: "Delete", destructive: true })) onRemove(row.id); }} aria-label="Delete"><Trash2 className="size-3.5" strokeWidth={1.8} /></Button></span>
      </div>
    </>
  );
}

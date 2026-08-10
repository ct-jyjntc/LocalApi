import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Waypoints } from "lucide-react";
import { api, type ProxyNode } from "@/lib/api";
import {
  EmptyState,
  PageHeader,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useAppDialog } from "@/components/app-dialog-context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const emptyForm = { name: "", url: "", enabled: true };

export function ProxiesPage() {
  const { t } = useI18n();
  const dialogs = useAppDialog();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["proxies"],
    queryFn: () => api.proxies.list(),
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyNode | null>(null);
  const [form, setForm] = useState(emptyForm);

  const save = useMutation({
    mutationFn: () => {
      if (editing) {
        return api.proxies.update(editing.id, {
          name: form.name,
          url: form.url,
          enabled: form.enabled,
        });
      }
      return api.proxies.create(form);
    },
    onSuccess: () => {
      toast.success(editing ? t("proxies.saved") : t("proxies.created"));
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.proxies.remove(id),
    onSuccess: () => {
      toast.success(t("proxies.removed"));
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.proxies.update(id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
      toast.success(t("proxies.updated"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function startCreate() {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function startEdit(node: ProxyNode) {
    setEditing(node);
    setForm({ name: node.name, url: node.url, enabled: node.enabled });
    setOpen(true);
  }

  async function confirmRemove(node: ProxyNode) {
    const ok = await dialogs.confirm({
      title: node.name,
      description: t("proxies.deleteConfirm"),
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) remove.mutate(node.id);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <PageHeader
        title={t("proxies.title")}
        description={t("proxies.desc")}
        actions={
          <Button size="sm" onClick={startCreate}>
            <Plus strokeWidth={1.8} />
            {t("proxies.add")}
          </Button>
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editing ? t("proxies.edit") : t("proxies.new")}</DialogTitle>
            <DialogDescription>{t("proxies.desc")}</DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <Field label={t("proxies.name")}>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="东京节点"
              />
            </Field>
            <Field label={t("proxies.url")}>
              <Input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={t("proxies.urlPlaceholder")}
                spellCheck={false}
                className="font-mono text-[11px]"
              />
            </Field>
            <div className="flex items-center justify-between rounded-md bg-secondary/55 px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5">
                <Waypoints className="size-3.5" />
                {t("common.active")}
              </span>
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">{t("proxies.urlHint")}</p>
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={save.isPending || !form.name.trim() || !form.url.trim()}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Card className="min-h-0 flex-1">
        {isLoading ? null : !data?.items.length ? (
          <EmptyState>
            <div className="flex flex-col items-center gap-2">
              <Waypoints className="size-5 text-muted-foreground/50" />
              <span>{t("proxies.empty")}</span>
              <Button size="sm" onClick={startCreate} className="mt-1">
                <Plus strokeWidth={1.8} />
                {t("proxies.add")}
              </Button>
            </div>
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <div className={TABLE_HEAD_CLASS}>
              <span className="min-w-0 flex-1">{t("proxies.name")}</span>
              <span className="w-72 shrink-0 text-right">{t("proxies.url")}</span>
              <span className="w-28 shrink-0 text-right">{t("common.status")}</span>
              <span className="w-36 shrink-0 text-right">{t("common.created")}</span>
              <span className="w-24 shrink-0 text-right">{t("common.actions")}</span>
            </div>
            {data.items.map((node) => (
              <div className={TABLE_ROW_CLASS} key={node.id}>
                <button
                  className="min-w-0 flex-1 truncate text-left font-medium"
                  onClick={() => startEdit(node)}
                >
                  {node.name}
                </button>
                <span className="w-72 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground">
                  {node.url}
                </span>
                <span className="flex w-28 shrink-0 items-center justify-end">
                  <Badge variant={node.enabled ? "success" : "secondary"}>
                    {node.enabled ? t("common.active") : t("common.off")}
                  </Badge>
                </span>
                <span className="w-36 shrink-0 truncate text-right text-muted-foreground">
                  {shortTime(node.updated_at)}
                </span>
                <span className="flex w-24 shrink-0 items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={() => toggle.mutate({ id: node.id, enabled: !node.enabled })}
                  >
                    <Badge variant={node.enabled ? "secondary" : "success"}>
                      {node.enabled ? t("common.off") : t("common.active")}
                    </Badge>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-muted-foreground hover:text-destructive"
                    onClick={() => confirmRemove(node)}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

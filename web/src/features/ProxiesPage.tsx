import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Library, Plus, RefreshCw, Trash2, Waypoints } from "lucide-react";
import { api, type ProxyLibrary, type ProxyNode } from "@/lib/api";
import {
  EmptyState,
  PageHeader,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PROTOCOLS = ["http", "https", "socks4", "socks5"] as const;

const emptyNodeForm = { name: "", url: "", enabled: true };
const emptyLibForm = {
  name: "",
  url: "",
  default_protocol: "http",
  enabled: true,
  auto_update: false,
  update_interval_minutes: 60,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

export function ProxiesPage() {
  const { t } = useI18n();
  const dialogs = useAppDialog();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["proxies"],
    queryFn: () => api.proxies.list(),
  });

  const [nodeOpen, setNodeOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<ProxyNode | null>(null);
  const [nodeForm, setNodeForm] = useState(emptyNodeForm);

  const [libOpen, setLibOpen] = useState(false);
  const [editingLib, setEditingLib] = useState<ProxyLibrary | null>(null);
  const [libForm, setLibForm] = useState(emptyLibForm);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["proxies"] });

  const saveNode = useMutation({
    mutationFn: () => {
      if (editingNode) {
        return api.proxies.update(editingNode.id, {
          name: nodeForm.name,
          url: nodeForm.url,
          enabled: nodeForm.enabled,
        });
      }
      return api.proxies.create(nodeForm);
    },
    onSuccess: () => {
      toast.success(t("proxies.saved"));
      setNodeOpen(false);
      setEditingNode(null);
      setNodeForm(emptyNodeForm);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeNode = useMutation({
    mutationFn: (id: string) => api.proxies.remove(id),
    onSuccess: () => {
      toast.success(t("proxies.removed"));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleNode = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.proxies.update(id, { enabled }),
    onSuccess: () => {
      invalidate();
      toast.success(t("proxies.updated"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveLibrary = useMutation({
    mutationFn: () => {
      const body = {
        name: libForm.name,
        url: libForm.url,
        default_protocol: libForm.default_protocol,
        enabled: libForm.enabled,
        auto_update: libForm.auto_update,
        update_interval_ms: Math.max(1, libForm.update_interval_minutes) * 60_000,
      };
      if (editingLib) {
        return api.proxies.libraryUpdate(editingLib.id, body);
      }
      return api.proxies.libraryCreate(body);
    },
    onSuccess: (lib) => {
      if (lib.import_error) {
        toast.error(t("proxies.libraryImportError", { error: lib.import_error }));
      } else {
        toast.success(editingLib ? t("proxies.librarySaved") : t("proxies.libraryCreated"));
      }
      setLibOpen(false);
      setEditingLib(null);
      setLibForm(emptyLibForm);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const refreshLibrary = useMutation({
    mutationFn: (id: string) => api.proxies.libraryRefresh(id),
    onSuccess: (result) => {
      invalidate();
      if (result.skipped) {
        toast.error(t("proxies.refreshedSkipped", { total: result.total }));
        return;
      }
      toast.success(
        t("proxies.refreshed", {
          added: result.added,
          removed: result.removed,
          total: result.total,
          alive: result.alive,
          dead: result.dead,
        }),
      );
    },
    onError: (e: Error) => toast.error(t("proxies.refreshFailed", { error: e.message })),
  });

  const toggleLibrary = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.proxies.libraryUpdate(id, { enabled }),
    onSuccess: () => {
      invalidate();
      toast.success(t("proxies.updated"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function startNodeCreate() {
    setEditingNode(null);
    setNodeForm(emptyNodeForm);
    setNodeOpen(true);
  }

  function startNodeEdit(node: ProxyNode) {
    setEditingNode(node);
    setNodeForm({ name: node.name, url: node.url, enabled: node.enabled });
    setNodeOpen(true);
  }

  function confirmNodeRemove(node: ProxyNode) {
    dialogs.confirm({
      title: node.name,
      description: t("proxies.deleteConfirm"),
      confirmText: "Delete",
      destructive: true,
    }).then((ok) => {
      if (ok) removeNode.mutate(node.id);
    });
  }

  function startLibCreate() {
    setEditingLib(null);
    setLibForm(emptyLibForm);
    setLibOpen(true);
  }

  function startLibEdit(lib: ProxyLibrary) {
    setEditingLib(lib);
    setLibForm({
      name: lib.name,
      url: lib.url,
      default_protocol: lib.default_protocol,
      enabled: lib.enabled,
      auto_update: lib.auto_update,
      update_interval_minutes: Math.round(lib.update_interval_ms / 60_000),
    });
    setLibOpen(true);
  }

  function confirmLibRemove(lib: ProxyLibrary) {
    dialogs.confirm({
      title: lib.name,
      description: t("proxies.libraryDeleteConfirm", { n: lib.node_count }),
      confirmText: "Delete",
      destructive: true,
    }).then((ok) => {
      if (ok) {
        api.proxies
          .libraryRemove(lib.id)
          .then(() => {
            toast.success(t("proxies.libraryRemoved"));
            invalidate();
          })
          .catch((e: Error) => toast.error(e.message));
      }
    });
  }

  const libs = data?.libraries ?? [];
  const nodes = data?.items ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <PageHeader
        title={t("proxies.title")}
        description={t("proxies.desc")}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={startLibCreate}>
              <Library strokeWidth={1.8} />
              {t("proxies.libraryNew")}
            </Button>
            <Button size="sm" onClick={startNodeCreate}>
              <Plus strokeWidth={1.8} />
              {t("proxies.add")}
            </Button>
          </div>
        }
      />

      {/* Library dialog */}
      <Dialog open={libOpen} onOpenChange={setLibOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editingLib ? t("proxies.libraryEdit") : t("proxies.libraryNew")}</DialogTitle>
            <DialogDescription>{t("proxies.libraryUrlHint")}</DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              saveLibrary.mutate();
            }}
          >
            <Field label={t("proxies.libraryName")}>
              <Input
                value={libForm.name}
                onChange={(e) => setLibForm({ ...libForm, name: e.target.value })}
                placeholder="公共代理池"
              />
            </Field>
            <Field label={t("proxies.libraryUrl")}>
              <Input
                value={libForm.url}
                onChange={(e) => setLibForm({ ...libForm, url: e.target.value })}
                placeholder={t("proxies.libraryUrlPlaceholder")}
                spellCheck={false}
                className="font-mono text-[11px]"
              />
            </Field>
            <Field label={t("proxies.defaultProtocol")}>
              <div className="flex flex-wrap gap-2">
                {PROTOCOLS.map((protocol) => {
                  const active = libForm.default_protocol === protocol;
                  return (
                    <button
                      key={protocol}
                      type="button"
                      onClick={() => setLibForm({ ...libForm, default_protocol: protocol })}
                      className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                        active
                          ? "border-foreground/40 bg-foreground/10 text-foreground"
                          : "border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {protocol}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="flex items-center justify-between rounded-md bg-secondary/55 px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5">
                <RefreshCw className="size-3.5" />
                {t("proxies.autoUpdate")}
              </span>
              <Switch
                checked={libForm.auto_update}
                onCheckedChange={(auto_update) => setLibForm({ ...libForm, auto_update })}
              />
            </div>
            {libForm.auto_update ? (
              <Field label={t("proxies.updateInterval")}>
                <Input
                  type="number"
                  min={1}
                  value={libForm.update_interval_minutes}
                  onChange={(e) =>
                    setLibForm({ ...libForm, update_interval_minutes: Number(e.target.value) || 60 })
                  }
                />
              </Field>
            ) : null}
            <p className="text-[11px] text-muted-foreground">{t("proxies.autoUpdateHint")}</p>
            <DialogFooter className="mt-2">
              <Button type="button" variant="secondary" onClick={() => setLibOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saveLibrary.isPending || !libForm.name.trim() || !libForm.url.trim()}>
                {saveLibrary.isPending ? t("common.loading") : t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Node dialog */}
      <Dialog open={nodeOpen} onOpenChange={setNodeOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{editingNode ? t("proxies.edit") : t("proxies.new")}</DialogTitle>
            <DialogDescription>{t("proxies.desc")}</DialogDescription>
          </DialogHeader>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              saveNode.mutate();
            }}
          >
            <Field label={t("proxies.name")}>
              <Input
                value={nodeForm.name}
                onChange={(e) => setNodeForm({ ...nodeForm, name: e.target.value })}
                placeholder="东京节点"
              />
            </Field>
            <Field label={t("proxies.url")}>
              <Input
                value={nodeForm.url}
                onChange={(e) => setNodeForm({ ...nodeForm, url: e.target.value })}
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
                checked={nodeForm.enabled}
                onCheckedChange={(enabled) => setNodeForm({ ...nodeForm, enabled })}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">{t("proxies.urlHint")}</p>
            <DialogFooter className="mt-2">
              <Button type="button" variant="secondary" onClick={() => setNodeOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saveNode.isPending || !nodeForm.name.trim() || !nodeForm.url.trim()}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {isLoading ? null : libs.length === 0 && nodes.length === 0 ? (
        <EmptyState>
          <div className="flex flex-col items-center gap-2">
            <Waypoints className="size-5 text-muted-foreground/50" />
            <span>{t("proxies.empty")}</span>
            <Button size="sm" onClick={startLibCreate} className="mt-1">
              <Library strokeWidth={1.8} />
              {t("proxies.libraryNew")}
            </Button>
          </div>
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6">
          {libs.length > 0 ? (
            <Card className="min-h-0">
              <div className="border-b border-border/60 px-4 py-2.5 text-xs font-medium text-muted-foreground">
                {t("proxies.libraries")} · {libs.length}
              </div>
              <div className="overflow-x-auto">
                <div className={TABLE_HEAD_CLASS}>
                  <span className="min-w-0 flex-1">{t("proxies.libraryName")}</span>
                  <span className="w-44 shrink-0 text-right">{t("proxies.libraryUrl")}</span>
                  <span className="w-24 shrink-0 text-right">{t("proxies.nodesCol")}</span>
                  <span className="w-28 shrink-0 text-right">{t("proxies.autoUpdate")}</span>
                  <span className="w-32 shrink-0 text-right">{t("common.status")}</span>
                  <span className="w-40 shrink-0 text-right">{t("common.actions")}</span>
                </div>
                {libs.map((lib) => (
                  <div className={TABLE_ROW_CLASS} key={lib.id}>
                    <button
                      className="min-w-0 flex-1 truncate text-left font-medium"
                      onClick={() => startLibEdit(lib)}
                    >
                      {lib.name}
                    </button>
                    <span className="w-44 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground">
                      {lib.url}
                    </span>
                    <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                      {lib.node_count}
                    </span>
                    <span className="w-28 shrink-0 text-right text-[11px] text-muted-foreground">
                      {lib.auto_update
                        ? `${t("common.on")} · ${Math.round(lib.update_interval_ms / 60_000)}m`
                        : t("common.off")}
                    </span>
                    <span className="flex w-32 shrink-0 items-center justify-end">
                      <Badge variant={lib.enabled ? "success" : "secondary"}>
                        {lib.enabled ? t("common.active") : t("common.off")}
                      </Badge>
                    </span>
                    <span className="flex w-40 shrink-0 items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={refreshLibrary.isPending}
                        onClick={() => refreshLibrary.mutate(lib.id)}
                        aria-label={t("proxies.refresh")}
                        title={t("proxies.refresh")}
                      >
                        <RefreshCw className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={() => toggleLibrary.mutate({ id: lib.id, enabled: !lib.enabled })}
                        aria-label={t("common.enabled")}
                      >
                        <Badge variant={lib.enabled ? "secondary" : "success"}>
                          {lib.enabled ? t("common.off") : t("common.active")}
                        </Badge>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        onClick={() => confirmLibRemove(lib)}
                        aria-label="Delete"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
              <p className="border-t border-border/40 px-4 py-2 text-[11px] text-muted-foreground">
                {t("proxies.libraryNodesHidden")}
              </p>
            </Card>
          ) : null}

          {nodes.length > 0 ? (
            <Card className="min-h-0 flex-1">
              <div className="border-b border-border/60 px-4 py-2.5 text-xs font-medium text-muted-foreground">
                {t("proxies.title")} · {nodes.length}
              </div>
              <div className="overflow-x-auto">
                <div className={TABLE_HEAD_CLASS}>
                  <span className="min-w-0 flex-1">{t("proxies.name")}</span>
                  <span className="w-72 shrink-0 text-right">{t("proxies.url")}</span>
                  <span className="w-28 shrink-0 text-right">{t("common.status")}</span>
                  <span className="w-36 shrink-0 text-right">{t("common.created")}</span>
                  <span className="w-24 shrink-0 text-right">{t("common.actions")}</span>
                </div>
                {nodes.map((node) => (
                  <div className={TABLE_ROW_CLASS} key={node.id}>
                    <button
                      className="min-w-0 flex-1 truncate text-left font-medium"
                      onClick={() => startNodeEdit(node)}
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
                        onClick={() => toggleNode.mutate({ id: node.id, enabled: !node.enabled })}
                      >
                        <Badge variant={node.enabled ? "secondary" : "success"}>
                          {node.enabled ? t("common.off") : t("common.active")}
                        </Badge>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        onClick={() => confirmNodeRemove(node)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}

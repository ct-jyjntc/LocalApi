import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { userApi, type ApiKeyRow } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { useAppDialog } from "@/components/app-dialog-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export function UserKeysPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const query = useQuery({ queryKey: ["user", "keys"], queryFn: userApi.keys.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiKeyRow | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["user", "keys"] });
  const create = useMutation({
    mutationFn: () => userApi.keys.create({ name: name.trim() }),
    onSuccess: (row) => {
      setName("");
      setCreateOpen(false);
      setCreated(row);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => userApi.keys.update(id, { enabled }), onSuccess: refresh, onError: (error: Error) => toast.error(error.message) });
  const remove = useMutation({ mutationFn: userApi.keys.remove, onSuccess: () => { toast.success(zh ? "API Key 已删除" : "API key deleted"); refresh(); }, onError: (error: Error) => toast.error(error.message) });
  const requestDelete = async (row: ApiKeyRow) => {
    if (await dialogs.confirm({ title: zh ? "删除 API Key" : "Delete API key", description: zh ? `删除“${row.name}”后，使用该密钥的客户端会立即失效。` : `Clients using “${row.name}” will stop working immediately.`, confirmText: zh ? "删除" : "Delete", destructive: true })) remove.mutate(row.id);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API Keys"
        description={zh ? "输入名称即可创建；余额调用受用户层级限制，/coding 调用受 Coding Plan 限制。" : "Name the key and create it. Account and Coding Plan limits apply automatically."}
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus data-icon="inline-start" />{zh ? "创建 API Key" : "Create API key"}</Button>}
      />
      <Card className="overflow-hidden">
        <div className={`${TABLE_HEAD_CLASS} hidden sm:flex`}><span className="w-36 shrink-0">{zh ? "名称" : "Name"}</span><span className="min-w-0 flex-1">Key</span><span className="hidden w-36 shrink-0 lg:block">{zh ? "最近使用" : "Last used"}</span><span className="w-28 shrink-0 text-right">{zh ? "操作" : "Actions"}</span></div>
        {!query.data?.items.length ? <EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : (zh ? "暂无 API Key" : "No API keys")}</EmptyState> : query.data.items.map((row) => <KeyRow key={row.id} row={row} zh={zh} onToggle={(enabled) => toggle.mutate({ id: row.id, enabled })} onRemove={() => requestDelete(row)} />)}
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{zh ? "创建 API Key" : "Create API key"}</DialogTitle><DialogDescription>{zh ? "只需要填写一个便于识别的名称，创建后即可调用全部可用模型。" : "Enter a recognizable name. Access rules are applied automatically."}</DialogDescription></DialogHeader>
          <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (name.trim()) create.mutate(); }}>
            <label className="flex flex-col gap-1.5"><Label htmlFor="user-key-name">{zh ? "名称" : "Name"}</Label><Input id="user-key-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={zh ? "例如：Codex 客户端" : "e.g. Codex client"} /></label>
            <DialogFooter className="mt-0"><Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>{zh ? "取消" : "Cancel"}</Button><Button type="submit" disabled={!name.trim() || create.isPending}>{create.isPending ? (zh ? "创建中…" : "Creating…") : (zh ? "创建" : "Create")}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(created)} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{zh ? "API Key 创建成功" : "API key created"}</DialogTitle><DialogDescription>{zh ? "请复制到客户端中使用。管理员界面和本页面仍可再次查看完整密钥。" : "Copy this key into your client."}</DialogDescription></DialogHeader>
          <div className="mt-4 flex items-center gap-2 rounded-md bg-secondary/55 p-3"><code className="min-w-0 flex-1 break-all font-mono text-xs">{created?.key}</code><Button variant="secondary" size="icon" onClick={async () => { if (!created?.key) return; await navigator.clipboard.writeText(created.key); toast.success(zh ? "已复制" : "Copied"); }}><Copy /></Button></div>
          <DialogFooter><Button onClick={() => setCreated(null)}>{zh ? "完成" : "Done"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KeyRow({ row, zh, onToggle, onRemove }: { row: ApiKeyRow; zh: boolean; onToggle: (enabled: boolean) => void; onRemove: () => void }) {
  const copy = async () => { if (!row.key) return; await navigator.clipboard.writeText(row.key); toast.success(zh ? "已复制" : "Copied"); };
  const value = row.key || `${row.key_prefix}…`;
  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border/40 p-3 text-xs sm:hidden"><div className="flex items-center justify-between gap-2"><p className="truncate font-medium">{row.name}</p><Badge variant={row.enabled ? "success" : "secondary"}>{row.enabled ? (zh ? "开启" : "On") : (zh ? "关闭" : "Off")}</Badge></div><div className="flex items-center gap-1 rounded-md bg-secondary/45 px-2.5 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[11px]">{value}</code>{row.key ? <Button variant="ghost" size="icon" className="size-7" onClick={copy}><Copy /></Button> : null}</div><div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{row.last_used_at ? shortTime(row.last_used_at) : (zh ? "尚未使用" : "Never used")}</span><span className="flex items-center gap-1"><Switch checked={row.enabled} onCheckedChange={onToggle} /><Button variant="ghost" size="icon" className="size-7" onClick={onRemove}><Trash2 /></Button></span></div></div>
      <div className={`${TABLE_ROW_CLASS} hidden sm:flex`}><span className="w-36 shrink-0 truncate">{row.name}</span><span className="flex min-w-0 flex-1 items-center gap-1"><code className="min-w-0 flex-1 truncate font-mono text-[11px]">{value}</code>{row.key ? <Button variant="ghost" size="icon" className="size-6" onClick={copy}><Copy /></Button> : null}</span><span className="hidden w-36 shrink-0 text-[11px] text-muted-foreground lg:block">{row.last_used_at ? shortTime(row.last_used_at) : (zh ? "尚未使用" : "Never used")}</span><span className="flex w-28 shrink-0 items-center justify-end gap-1"><Switch checked={row.enabled} onCheckedChange={onToggle} /><Button variant="ghost" size="icon" className="size-6" onClick={onRemove}><Trash2 /></Button></span></div>
    </>
  );
}

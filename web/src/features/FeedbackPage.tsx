import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareText, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { api, type FeedbackAttachment, type FeedbackThread } from "@/lib/api";
import { EmptyState, EntryIcon, PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function statusBadge(thread: FeedbackThread) {
  if (thread.status === "resolved") return <Badge variant="secondary">已解决</Badge>;
  if (thread.last_sender_type === "admin") return <Badge variant="default">客服回复</Badge>;
  return <Badge variant="success">用户回复</Badge>;
}

export function FeedbackPage() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["admin", "feedback"], queryFn: api.commercial.feedback.list });
  const unread = useQuery({ queryKey: ["admin", "feedback", "unread"], queryFn: api.commercial.feedback.unread, refetchInterval: 10_000 });
  const [selected, setSelected] = useState<FeedbackThread | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ userId: "", subject: "", body: "" });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["admin", "feedback"] });
    await qc.invalidateQueries({ queryKey: ["admin", "feedback", "unread"] });
    const result = await query.refetch();
    if (selected) setSelected(result.data?.items.find(item => item.id === selected.id) || null);
  };

  const createTicket = useMutation({
    mutationFn: () => api.commercial.feedback.create(createForm.userId, createForm.subject, createForm.body),
    onSuccess: () => {
      setCreateOpen(false);
      setCreateForm({ userId: "", subject: "", body: "" });
      refresh();
      toast.success("工单已创建");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.commercial.feedback.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "feedback", "unread"] }),
  });

  const openThread = (thread: FeedbackThread) => {
    setSelected(thread);
    if (thread.admin_unread) markRead.mutate(thread.id);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="用户反馈"
        description="查看反馈状态；打开详情后回复用户或更新处理状态。"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            主动开工单
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {!query.data?.items.length ? (
          <EmptyState>{query.isLoading ? "加载中…" : "暂无用户反馈"}</EmptyState>
        ) : (
          query.data.items.map(thread => (
            <button
              key={thread.id}
              className={`flex min-h-14 w-full items-center gap-3 border-b border-border/40 px-4 py-3 text-left text-xs transition-colors last:border-0 hover:bg-secondary/40 ${thread.admin_unread ? "bg-secondary/20" : ""}`}
              onClick={() => openThread(thread)}
            >
              <EntryIcon icon={MessageSquareText} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{thread.subject}</p>
                  <span className="truncate text-[11px] text-muted-foreground">{thread.display_name} @{thread.username}</span>
                  {thread.admin_unread ? <span className="size-1.5 shrink-0 rounded-full bg-foreground" /> : null}
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {thread.messages.at(-1)?.body || "图片附件"} · {new Date(thread.updated_at).toLocaleString()}
                </p>
              </div>
              {statusBadge(thread)}
            </button>
          ))
        )}
      </Card>
      {selected ? <FeedbackDialog thread={selected} onClose={() => setSelected(null)} refresh={refresh} /> : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>主动开工单</DialogTitle>
            <DialogDescription>向指定用户发起一个新工单，用户会在反馈列表看到并收到角标提醒。</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <Input placeholder="用户 ID" value={createForm.userId} onChange={e => setCreateForm({ ...createForm, userId: e.target.value })} />
            <Input placeholder="工单标题" value={createForm.subject} onChange={e => setCreateForm({ ...createForm, subject: e.target.value })} />
            <Textarea className="min-h-28" placeholder="回复内容" value={createForm.body} onChange={e => setCreateForm({ ...createForm, body: e.target.value })} />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button disabled={!createForm.userId.trim() || !createForm.subject.trim() || !createForm.body.trim() || createTicket.isPending} onClick={() => createTicket.mutate()}>
              <Send />
              创建工单
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FeedbackDialog({ thread, onClose, refresh }: { thread: FeedbackThread; onClose: () => void; refresh: () => void }) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<FeedbackAttachment[]>([]);
  const open = thread.status === "open";
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const reply = useMutation({
    mutationFn: () => api.commercial.feedback.reply(thread.id, body, files),
    onSuccess: () => { setBody(""); setFiles([]); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const status = useMutation({
    mutationFn: () => api.commercial.feedback.status(thread.id, open ? "resolved" : "open"),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-6">
            <DialogTitle>{thread.subject}</DialogTitle>
            {statusBadge(thread)}
          </div>
          <DialogDescription>{thread.display_name} @{thread.username} · {new Date(thread.created_at).toLocaleString()}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 max-h-[48vh] space-y-2 overflow-y-auto pr-1">
          {thread.messages.map(message => (
            <div key={message.id} className={`max-w-[88%] rounded-md px-3 py-2 text-xs ${message.sender_type === "admin" ? "ml-auto bg-foreground text-background" : "bg-secondary/55"}`}>
              <p className="whitespace-pre-wrap">{message.body}</p>
              {message.attachments?.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {message.attachments.map((item, index) => (
                    <button key={index} type="button" onClick={() => setPreviewSrc(item.data)} className="block overflow-hidden rounded-md transition-opacity hover:opacity-80">
                      <img src={item.data} alt={item.name} className="h-20 max-w-32 rounded-md object-cover" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {previewSrc && (
          <Dialog open onOpenChange={(v) => { if (!v) setPreviewSrc(null); }}>
            <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 sm:max-w-[800px]">
              <img src={previewSrc} alt="preview" className="max-h-[85vh] w-full rounded-md object-contain" onClick={() => setPreviewSrc(null)} />
            </DialogContent>
          </Dialog>
        )}
        {open ? (
          <div className="space-y-3 border-t border-border/50 pt-4">
            <Textarea placeholder="回复用户" value={body} onChange={e => setBody(e.target.value)} />
            <ImageInput files={files} onChange={setFiles} />
            <DialogFooter>
              <Button variant="secondary" onClick={() => status.mutate()}>标记已解决</Button>
              <Button disabled={(!body.trim() && !files.length) || reply.isPending} onClick={() => reply.mutate()}>发送回复</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/45 px-3 py-2">
            <p className="text-xs text-muted-foreground">用户当前无法继续回复。</p>
            <Button size="sm" variant="secondary" onClick={() => status.mutate()}>重新打开</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImageInput({ files, onChange }: { files: FeedbackAttachment[]; onChange: (value: FeedbackAttachment[]) => void }) {
  return (
    <label className="inline-flex h-8 w-fit cursor-pointer items-center rounded-full bg-secondary px-3 text-xs text-muted-foreground">
      添加图片{files.length ? ` · ${files.length}` : ""}
      <input className="hidden" type="file" accept="image/*" multiple onChange={async e => onChange(await Promise.all(Array.from(e.target.files || []).slice(0, 3).map(file => new Promise<FeedbackAttachment>((resolve, reject) => { if (file.size > 2_000_000) return reject(new Error("Image too large")); const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result) }); reader.onerror = reject; reader.readAsDataURL(file); }))))} />
    </label>
  );
}

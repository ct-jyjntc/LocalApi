import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, MessageSquareText, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { userApi, type FeedbackAttachment, type FeedbackThread } from "@/lib/api";
import { EmptyState, EntryIcon, PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";

function statusBadge(thread: FeedbackThread, zh: boolean) {
  if (thread.status === "resolved") return <Badge variant="secondary">{zh ? "已解决" : "Resolved"}</Badge>;
  if (thread.last_sender_type === "admin") return <Badge variant="default">{zh ? "客服回复" : "Admin replied"}</Badge>;
  return <Badge variant="success">{zh ? "用户回复" : "User replied"}</Badge>;
}

export function UserFeedbackPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["user", "feedback"], queryFn: userApi.feedback.list });
  const unread = useQuery({ queryKey: ["user", "feedback", "unread"], queryFn: userApi.feedback.unread, refetchInterval: 10_000 });
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<FeedbackThread | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<FeedbackAttachment[]>([]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["user", "feedback"] });
    qc.invalidateQueries({ queryKey: ["user", "feedback", "unread"] });
  };

  const create = useMutation({
    mutationFn: () => userApi.feedback.create(subject, body, files),
    onSuccess: () => {
      setCreateOpen(false);
      setSubject("");
      setBody("");
      setFiles([]);
      refresh();
      toast.success(zh ? "反馈已提交" : "Feedback sent");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => userApi.feedback.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user", "feedback", "unread"] }),
  });

  const openThread = (thread: FeedbackThread) => {
    setSelected(thread);
    if (thread.user_unread) markRead.mutate(thread.id);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "我的反馈" : "My feedback"}
        description={zh ? "查看历史反馈，或提交新的问题。" : "Review previous feedback or report a new issue."}
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus />{zh ? "新建反馈" : "New feedback"}</Button>}
      />
      <Card className="overflow-hidden">
        {!query.data?.items.length ? (
          <EmptyState>{query.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "暂无反馈" : "No feedback yet"}</EmptyState>
        ) : (
          query.data.items.map(thread => (
            <button
              key={thread.id}
              className={`flex min-h-14 w-full items-center gap-3 border-b border-border/40 px-4 py-3 text-left text-xs transition-colors last:border-0 hover:bg-secondary/40 ${thread.user_unread ? "bg-secondary/20" : ""}`}
              onClick={() => openThread(thread)}
            >
              <EntryIcon icon={MessageSquareText} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{thread.subject}</p>
                  {thread.user_unread ? <span className="size-1.5 shrink-0 rounded-full bg-foreground" /> : null}
                </div>
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {thread.messages.at(-1)?.body || (zh ? "图片附件" : "Image attachment")} · {new Date(thread.updated_at).toLocaleString()}
                </p>
              </div>
              {statusBadge(thread, zh)}
            </button>
          ))
        )}
      </Card>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{zh ? "新建反馈" : "New feedback"}</DialogTitle>
            <DialogDescription>{zh ? "请简洁描述问题；需要时可附加截图。" : "Describe the issue and attach screenshots if needed."}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <Input placeholder={zh ? "反馈标题" : "Subject"} value={subject} onChange={e => setSubject(e.target.value)} />
            <Textarea className="min-h-28" placeholder={zh ? "请描述遇到的问题" : "Describe the issue"} value={body} onChange={e => setBody(e.target.value)} />
            <AttachmentInput files={files} onChange={setFiles} />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{zh ? "取消" : "Cancel"}</Button>
            <Button disabled={!subject.trim() || !body.trim() || create.isPending} onClick={() => create.mutate()}>
              <Send />{zh ? "提交" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {selected ? (
        <ThreadDialog
          thread={selected}
          zh={zh}
          onClose={() => setSelected(null)}
          onDone={() => {
            refresh();
            query.refetch().then(result => setSelected(result.data?.items.find(x => x.id === selected.id) || null));
          }}
        />
      ) : null}
    </div>
  );
}

function ThreadDialog({ thread, zh, onClose, onDone }: { thread: FeedbackThread; zh: boolean; onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<FeedbackAttachment[]>([]);
  const open = thread.status === "open";
  const reply = useMutation({
    mutationFn: () => userApi.feedback.reply(thread.id, body, files),
    onSuccess: () => { setBody(""); setFiles([]); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="max-w-[680px]">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-6">
            <DialogTitle>{thread.subject}</DialogTitle>
            {statusBadge(thread, zh)}
          </div>
          <DialogDescription>{new Date(thread.created_at).toLocaleString()}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 max-h-[48vh] space-y-2 overflow-y-auto pr-1">
          {thread.messages.map(message => (
            <MessageBubble key={message.id} message={message} own={message.sender_type === "user"} />
          ))}
        </div>
        {open ? (
          <div className="space-y-3 border-t border-border/50 pt-4">
            <Textarea placeholder={zh ? "继续回复" : "Reply"} value={body} onChange={e => setBody(e.target.value)} />
            <AttachmentInput files={files} onChange={setFiles} />
            <DialogFooter>
              <Button variant="secondary" onClick={onClose}>{zh ? "关闭" : "Close"}</Button>
              <Button disabled={(!body.trim() && !files.length) || reply.isPending} onClick={() => reply.mutate()}>
                {zh ? "发送回复" : "Send reply"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="rounded-md bg-secondary/45 px-3 py-2 text-xs text-muted-foreground">
            {zh ? "该反馈已解决。如需继续沟通，请等待管理员重新打开。" : "This feedback is resolved. An administrator must reopen it before you can reply."}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MessageBubble({ message, own }: { message: FeedbackThread["messages"][number]; own: boolean }) {
  return (
    <div className={`max-w-[88%] rounded-md px-3 py-2 text-xs ${own ? "ml-auto bg-foreground text-background" : "bg-secondary/55"}`}>
      <p className="whitespace-pre-wrap">{message.body}</p>
      <Images items={message.attachments} />
    </div>
  );
}

function AttachmentInput({ files, onChange }: { files: FeedbackAttachment[]; onChange: (value: FeedbackAttachment[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-full bg-secondary px-3 text-xs text-muted-foreground hover:text-foreground">
        <ImagePlus className="size-3.5" />
        {("添加图片")}
        <input className="hidden" type="file" accept="image/*" multiple onChange={async e => onChange(await Promise.all(Array.from(e.target.files || []).slice(0, 3).map(toAttachment)))} />
      </label>
      {files.map(file => <span key={file.name} className="max-w-40 truncate text-[11px] text-muted-foreground">{file.name}</span>)}
    </div>
  );
}

const toAttachment = (file: File) => new Promise<FeedbackAttachment>((resolve, reject) => {
  if (file.size > 2_000_000) return reject(new Error("Image too large"));
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name, type: file.type, data: String(reader.result) });
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

function Images({ items }: { items: FeedbackAttachment[] }) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  if (!items?.length) return null;
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.map((item, index) => (
          <button key={index} type="button" onClick={() => setPreviewSrc(item.data)} className="block overflow-hidden rounded-md transition-opacity hover:opacity-80">
            <img src={item.data} alt={item.name} className="h-20 max-w-32 rounded-md object-cover" />
          </button>
        ))}
      </div>
      {previewSrc && (
        <Dialog open onOpenChange={(v) => { if (!v) setPreviewSrc(null); }}>
          <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 sm:max-w-[800px]" onCloseAutoFocus={() => setPreviewSrc(null)}>
            <img src={previewSrc} alt="preview" className="max-h-[85vh] w-full rounded-md object-contain" onClick={() => setPreviewSrc(null)} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

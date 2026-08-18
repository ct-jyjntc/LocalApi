import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api, type RiskGroup, type ModelPrice } from "@/lib/api";
import { EmptyState, PageHeader, TABLE_HEAD_CLASS, TABLE_ROW_CLASS } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCredits, shortTime } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

function statusVariant(status: string) {
  if (status === "active" || status === "open") return "success" as const;
  if (status === "suspended") return "default" as const;
  return "destructive" as const;
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function scoreVariant(score: number | null) {
  if (score == null) return "secondary" as const;
  if (score >= 70) return "destructive" as const;
  if (score >= 40) return "default" as const;
  return "success" as const;
}

export function RiskRadarPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const [hours, setHours] = useState(72);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const report = useQuery({
    queryKey: ["commercial", "risk-radar", hours],
    queryFn: () => api.commercial.riskRadar(hours),
    staleTime: 10_000,
  });
  const groups = report.data?.groups ?? [];
  const selected = groups.find((group) => group.id === selectedId) ?? null;

  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "disabled" | "suspended" | "ignored" }) =>
      api.commercial.resolveRiskGroup(id, action),
    onSuccess: (result) => {
      toast.success(
        zh
          ? result.action === "ignored"
            ? "已忽略该组"
            : `已将组内 ${result.updated} 个账号设为 ${result.action}`
          : result.action === "ignored"
            ? "Group ignored"
            : `Set ${result.updated} accounts to ${result.action}`,
      );
      qc.invalidateQueries({ queryKey: ["commercial", "risk-radar"] });
      qc.invalidateQueries({ queryKey: ["commercial", "users"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const analyze = useMutation({
    mutationFn: (id: string) => api.commercial.analyzeRiskGroup(id),
    onSuccess: (result) => {
      toast.success(zh ? `AI打分: ${result.score}分` : `AI score: ${result.score}`);
      qc.invalidateQueries({ queryKey: ["commercial", "risk-radar"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // AI model selection
  const aiModel = useQuery({
    queryKey: ["commercial", "risk-radar", "ai-model"],
    queryFn: () => api.commercial.getRiskAIModel(),
  });
  const [modelOpen, setModelOpen] = useState(false);
  const saveModel = useMutation({
    mutationFn: (model: string) => api.commercial.setRiskAIModel(model),
    onSuccess: () => {
      toast.success(zh ? "AI模型已设置" : "AI model saved");
      qc.invalidateQueries({ queryKey: ["commercial", "risk-radar", "ai-model"] });
      setModelOpen(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // Get available models from admin pricing
  const prices = useQuery({ queryKey: ["commercial", "prices"], queryFn: () => api.commercial.prices.list() });
  const availableModels: ModelPrice[] = (prices.data?.items || []).filter((p) => p.enabled);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={zh ? "风控雷达" : "Risk radar"}
        description={
          zh
            ? "只观察、不自动封。点开一组对照提示词、相似度和账号背景，再决定整组处理。"
            : "Observe only. Open a group to compare prompts and decide together."
        }
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-secondary/55 px-2.5 text-xs"
              value={hours}
              onChange={(event) => setHours(Number(event.target.value))}
            >
              <option value={24}>{zh ? "近 24 小时" : "Last 24h"}</option>
              <option value={72}>{zh ? "近 72 小时" : "Last 72h"}</option>
              <option value={168}>{zh ? "近 7 天" : "Last 7d"}</option>
            </select>
            <Button size="sm" variant="secondary" onClick={() => setModelOpen(true)}>
              {zh ? "AI模型" : "AI model"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => report.refetch()}>
              {zh ? "刷新" : "Refresh"}
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={zh ? "待处理组" : "Open groups"} value={String(report.data?.summary.open_groups ?? 0)} />
        <StatCard label={zh ? "组内账号" : "Members"} value={String(report.data?.summary.members ?? 0)} />
        <StatCard label={zh ? "已处理组" : "Resolved"} value={String(report.data?.summary.resolved ?? 0)} />
      </div>

      {aiModel.data?.model ? (
        <div className="rounded-md bg-secondary/35 px-3 py-2 text-[11px] text-muted-foreground">
          {zh ? "AI分析模型" : "AI model"}: <span className="font-mono text-foreground">{aiModel.data.model}</span>
        </div>
      ) : (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {zh ? "未配置AI分析模型，点击右上角「AI模型」选择" : "No AI model configured. Click \"AI model\" to select one."}
        </div>
      )}

      <Card className="overflow-hidden">
        {!groups.length ? (
          <EmptyState>{report.isLoading ? (zh ? "加载中…" : "Loading…") : zh ? "当前窗口没有连坐组" : "No collusion groups"}</EmptyState>
        ) : (
          <>
            <div className="hidden sm:block">
              <div className={TABLE_HEAD_CLASS}>
                <span className="min-w-0 flex-1">{zh ? "模型 / 原因" : "Model / reason"}</span>
                <span className="w-16 shrink-0">{zh ? "状态" : "Status"}</span>
                <span className="w-12 shrink-0">{zh ? "人数" : "Users"}</span>
                <span className="w-20 shrink-0">{zh ? "相似度" : "Similar"}</span>
                <span className="w-16 shrink-0">{zh ? "AI" : "AI"}</span>
                <span className="w-28 shrink-0">{zh ? "最近" : "Last seen"}</span>
              </div>
              {groups.map((group) => (
                <button type="button" className={`${TABLE_ROW_CLASS} w-full text-left`} key={group.id} onClick={() => setSelectedId(group.id)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{group.model}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{group.reason}</span>
                  </span>
                  <span className="w-16 shrink-0">
                    <Badge variant={group.status === "open" ? "default" : "secondary"}>{group.status}</Badge>
                  </span>
                  <span className="w-12 shrink-0 tabular-nums">{group.member_count}</span>
                  <span className="w-20 shrink-0 tabular-nums">{pct(group.max_similarity || 0)}</span>
                  <span className="w-16 shrink-0">
                    {group.ai_score != null ? (
                      <Badge variant={scoreVariant(group.ai_score)}>{group.ai_score}</Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    )}
                  </span>
                  <span className="w-28 shrink-0 text-[11px] text-muted-foreground">{shortTime(group.last_seen_at)}</span>
                </button>
              ))}
            </div>
            <div className="divide-y divide-border/40 sm:hidden">
              {groups.map((group) => (
                <button type="button" className="w-full space-y-1 p-3 text-left text-xs" key={group.id} onClick={() => setSelectedId(group.id)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{group.model}</span>
                    <div className="flex items-center gap-1.5">
                      {group.ai_score != null ? <Badge variant={scoreVariant(group.ai_score)}>{group.ai_score}</Badge> : null}
                      <Badge variant={group.status === "open" ? "default" : "secondary"}>{group.status}</Badge>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {group.member_count} {zh ? "人" : "users"} · {pct(group.max_similarity || 0)} · {shortTime(group.last_seen_at)}
                  </p>
                </button>
              ))}
            </div>
          </>
        )}
      </Card>

      <RiskGroupDialog
        group={selected}
        zh={zh}
        pending={resolve.isPending}
        analyzing={analyze.isPending}
        onClose={() => setSelectedId(null)}
        onResolve={(action) => selected && resolve.mutate({ id: selected.id, action })}
        onAnalyze={() => selected && analyze.mutate(selected.id)}
      />

      {/* AI Model Selection Dialog */}
      <Dialog open={modelOpen} onOpenChange={setModelOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{zh ? "选择AI分析模型" : "Select AI model"}</DialogTitle>
            <DialogDescription>
              {zh ? "选择一个已配置的模型用于风控AI打分分析。" : "Choose a configured model for risk AI scoring."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            {availableModels.length === 0 ? (
              <p className="text-xs text-muted-foreground">{zh ? "没有可用的模型" : "No models available"}</p>
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {availableModels.map((mp) => (
                  <button
                    key={mp.model}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors hover:bg-secondary/50 ${
                      aiModel.data?.model === mp.model ? "bg-secondary/60" : "bg-secondary/30"
                    }`}
                    onClick={() => saveModel.mutate(mp.model)}
                  >
                    <span className="truncate font-mono">{mp.model}</span>
                    {aiModel.data?.model === mp.model ? <Badge variant="success">{zh ? "当前" : "Active"}</Badge> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RiskGroupDialog({
  group,
  zh,
  pending,
  analyzing,
  onClose,
  onResolve,
  onAnalyze,
}: {
  group: RiskGroup | null;
  zh: boolean;
  pending: boolean;
  analyzing: boolean;
  onClose: () => void;
  onResolve: (action: "disabled" | "suspended" | "ignored") => void;
  onAnalyze: () => void;
}) {
  if (!group) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[88vh] max-w-[820px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <Badge variant={group.status === "open" ? "default" : "secondary"}>{group.status}</Badge>
            <span className="font-mono text-sm font-normal">{group.model}</span>
            {group.ai_score != null ? <Badge variant={scoreVariant(group.ai_score)}>AI {group.ai_score}</Badge> : null}
          </DialogTitle>
          <DialogDescription>{group.reason}</DialogDescription>
        </DialogHeader>

        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <Meta label={zh ? "人数" : "Users"} value={String(group.member_count)} />
          <Meta label={zh ? "最高相似" : "Max similar"} value={pct(group.max_similarity || 0)} />
          <Meta label={zh ? "最短间隔" : "Min gap"} value={`${group.min_gap_seconds ?? "—"}s`} />
          <Meta label={zh ? "窗口" : "Window"} value={`${group.window_seconds ?? 120}s`} />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {zh ? "最近" : "Last"} {shortTime(group.last_seen_at)} · {zh ? "首次" : "first"} {shortTime(group.created_at)}
        </p>

        {/* AI Analysis */}
        {group.ai_score != null ? (
          <div className="mt-3 rounded-md bg-secondary/45 p-3">
            <div className="flex items-center gap-2">
              <Badge variant={scoreVariant(group.ai_score)}>{zh ? "AI分数" : "AI score"}: {group.ai_score}</Badge>
              {group.ai_analyzed_at ? <span className="text-[11px] text-muted-foreground">{shortTime(group.ai_analyzed_at)}</span> : null}
            </div>
            {group.ai_verdict ? (
              <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">{group.ai_verdict}</p>
            ) : null}
          </div>
        ) : null}

        {group.status === "open" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={analyzing} onClick={onAnalyze}>
              {analyzing ? (zh ? "分析中…" : "Analyzing…") : zh ? "AI分析" : "AI analyze"}
            </Button>
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => onResolve("disabled")}>
              {zh ? "整组禁用" : "Disable group"}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => onResolve("suspended")}>
              {zh ? "整组暂停" : "Suspend group"}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => onResolve("ignored")}>
              {zh ? "忽略" : "Ignore"}
            </Button>
          </div>
        ) : (
          <div className="mt-3">
            <Badge variant="secondary">{group.resolved_action || group.status}</Badge>
          </div>
        )}

        {group.sample_preview ? (
          <div className="mt-4 rounded-md bg-secondary/45 p-3">
            <p className="text-[11px] font-medium">{zh ? "代表性提示词摘录" : "Sample prompt excerpt"}</p>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">{group.sample_preview}</p>
          </div>
        ) : null}

        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium">{zh ? "连坐账号" : "Accounts in this group"}</p>
          <div className="divide-y divide-border/40 rounded-md bg-secondary/35">
            {group.members.map((member) => (
              <div className="space-y-1.5 px-3 py-2.5 text-xs" key={member.user_id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{member.display_name}</span>
                    <span className="ml-1 text-muted-foreground">@{member.username}</span>
                  </div>
                  <Badge variant={statusVariant(member.status)}>{member.status}</Badge>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{zh ? "注册" : "Joined"} {member.created_at ? shortTime(member.created_at) : "—"}</span>
                  <span>{zh ? "累计充值" : "Top-up"} {formatCredits(member.lifetime_topup_micros)}</span>
                  <span>{zh ? "套餐" : "Plan"} {member.plan_name || (zh ? "无" : "none")}</span>
                  <span>×{member.hit_count}</span>
                  {member.client_ips.length ? <span>IP {member.client_ips.join(", ")}</span> : null}
                </div>
                {member.preview ? (
                  <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">{member.preview}</p>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {group.events.length ? (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-medium">{zh ? "对照明细" : "Why they were grouped"}</p>
            {group.events.map((event) => (
              <div className="rounded-md border border-border/50 p-3 text-[11px]" key={event.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>@{event.actor_username} → @{event.peer_username}</span>
                  <span className="text-muted-foreground">
                    {event.exact_match ? (zh ? "完全相同" : "exact") : pct(event.similarity)} · {event.gap_seconds}s · {shortTime(event.created_at)}
                  </span>
                </div>
                {event.client_ip || event.user_agent ? (
                  <p className="mt-1 text-muted-foreground">
                    {event.client_ip || "—"} {event.user_agent ? `· ${event.user_agent}` : ""}
                  </p>
                ) : null}
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <pre className="whitespace-pre-wrap break-words rounded bg-secondary/50 p-2 font-mono leading-5">{event.preview || "—"}</pre>
                  <pre className="whitespace-pre-wrap break-words rounded bg-secondary/50 p-2 font-mono leading-5">{event.peer_preview || "—"}</pre>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-medium tabular-nums">{value}</p>
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-secondary/55 px-2.5 py-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate tabular-nums" title={value}>{value}</p>
    </div>
  );
}

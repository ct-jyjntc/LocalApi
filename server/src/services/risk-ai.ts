import { db, getSetting, setSetting } from "../db";
import { listRiskRadar } from "./risk-radar";
import { listProvidersForModel } from "./providers";
import { pickProviderKey } from "./providers";
import { mapProviderModel } from "./providers";
import { readLogBodies } from "./log-bodies";
import { nowIso } from "../utils/time";

export function getRiskRadarAIModel(): string {
  return (getSetting("risk_radar_ai_model") || "").trim();
}

export function setRiskRadarAIModel(model: string): void {
  setSetting("risk_radar_ai_model", model.trim());
}

function sharedPrefix(a: string, b: string, max = 200): string {
  const n = Math.min(a.length, b.length, max);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

function buildAnalysisPrompt(groupId: string): { prompt: string; groupInfo: string } | null {
  const report = listRiskRadar(72);
  const group = report.groups.find((g) => g.id === groupId);
  if (!group) return null;

  const lines: string[] = [];
  lines.push("你是一个风控分析助手。以下是系统检测到的一组疑似连坐用户的信息。");
  lines.push("请根据这些信息判断这些用户是否可能是同一个人或关联用户，给出0-100的风险分数和简短结论。");
  lines.push("");
  lines.push("## 组信息");
  lines.push(`- 模型: ${group.model}`);
  lines.push(`- 原因: ${group.reason}`);
  lines.push(`- 最高相似度: ${Math.round(group.max_similarity * 100)}%`);
  lines.push(`- 最短间隔: ${group.min_gap_seconds ?? "—"}秒`);
  lines.push(`- 窗口: ${group.window_seconds ?? 120}秒`);
  lines.push(`- 成员数: ${group.member_count}`);
  lines.push(`- 命中次数: ${group.hit_count}`);
  lines.push("");

  lines.push("## 成员信息");
  for (const m of group.members) {
    lines.push(`### ${m.display_name} (@${m.username})`);
    lines.push(`- 状态: ${m.status}`);
    lines.push(`- 注册时间: ${m.created_at || "—"}`);
    lines.push(`- 最后登录: ${m.last_login_at || "—"}`);
    lines.push(`- 累计充值: ${m.lifetime_topup_micros}`);
    lines.push(`- 套餐: ${m.plan_name || "无"}`);
    lines.push(`- 命中次数: ${m.hit_count}`);
    lines.push(`- IP地址: ${m.client_ips.join(", ") || "—"}`);
    if (m.preview) {
      lines.push(`- 提示词摘录: ${m.preview.slice(0, 500)}`);
    }
    lines.push("");
  }

  lines.push("## 对照明细");
  for (const e of group.events.slice(0, 10)) {
    lines.push(`- ${e.actor_username} → ${e.peer_username}: 相似度${Math.round(e.similarity * 100)}%${e.exact_match ? "（完全相同）" : ""}，间隔${e.gap_seconds}秒，IP: ${e.client_ip || "—"}`);
    if (e.preview && e.peer_preview) {
      const shared = sharedPrefix(e.preview, e.peer_preview);
      if (shared.length >= 30) {
        lines.push(`  共同部分（两者开头一致）: ${shared.slice(0, 150)}${shared.length >= 150 ? "…" : ""}`);
        lines.push(`  A 的差异部分: ${e.preview.slice(shared.length, shared.length + 150) || "（无）"}`);
        lines.push(`  B 的差异部分: ${e.peer_preview.slice(shared.length, shared.length + 150) || "（无）"}`);
      } else {
        if (e.preview) lines.push(`  摘录A: ${e.preview.slice(0, 200)}`);
        if (e.peer_preview) lines.push(`  摘录B: ${e.peer_preview.slice(0, 200)}`);
      }
    } else {
      if (e.preview) lines.push(`  摘录A: ${e.preview.slice(0, 200)}`);
      if (e.peer_preview) lines.push(`  摘录B: ${e.peer_preview.slice(0, 200)}`);
    }
  }

  lines.push("");
  lines.push("## 研判要点");
  lines.push("- 摘录内容来自用户消息。如果两人的相似全部来自客户端/工具自带的公共模板（如 Claude Code 等 Agent 的固定开场白、流行越狱模板），而各自的任务内容并不相似，属于弱信号，应给低分。");
  lines.push("- 只有用户自己输入的任务内容高度一致（共同部分本身就是具体任务而非套话），才是强信号。");
  lines.push("");
  lines.push("请输出JSON格式：{\"score\": 0-100, \"verdict\": \"简短结论\"}");
  lines.push("分数越高表示越可能是同一用户或关联用户。");

  return { prompt: lines.join("\n"), groupInfo: `${group.model} / ${group.member_count}人` };
}

async function callAIModel(model: string, prompt: string): Promise<{ score: number; verdict: string; raw: string }> {
  const provider = listProvidersForModel(model)[0];
  if (!provider) throw new Error(`没有可用的渠道提供模型 ${model}`);

  const upstreamModel = mapProviderModel(provider, model);
  const key = pickProviderKey(provider);
  if (!key) throw new Error(`渠道 ${provider.name} 没有配置 API Key`);

  const baseUrl = provider.base_url.replace(/\/+$/, "");
  const url = `${baseUrl}/v1/chat/completions`;
  const body = {
    model: upstreamModel,
    messages: [
      { role: "system", content: "你是风控分析助手，只输出JSON。" },
      { role: "user", content: prompt },
    ],
    max_tokens: 500,
    stream: false,
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`AI模型返回 ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json() as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content : "";

    // Parse JSON from content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let score = 50;
    let verdict = "无法解析AI输出";
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 50)));
        verdict = String(parsed.verdict || "无结论").slice(0, 500);
      } catch {
        verdict = content.slice(0, 500);
      }
    } else {
      verdict = content.slice(0, 500);
    }
    return { score, verdict, raw: content };
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeRiskGroup(groupId: string): Promise<{ score: number; verdict: string; analyzed_at: string } | null> {
  const model = getRiskRadarAIModel();
  if (!model) throw new Error("未配置风控AI模型，请在设置中选择");

  const analysis = buildAnalysisPrompt(groupId);
  if (!analysis) return null;

  const result = await callAIModel(model, analysis.prompt);
  const now = nowIso();

  db.prepare(
    `UPDATE risk_groups SET ai_score = ?, ai_verdict = ?, ai_analyzed_at = ? WHERE id = ?`,
  ).run(result.score, result.verdict, now, groupId);

  return { score: result.score, verdict: result.verdict, analyzed_at: now };
}

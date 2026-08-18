import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { db, getSetting } from "../db";
import { nowIso } from "../utils/time";

export const FREE_PROMPT_WINDOW_SECONDS_DEFAULT = 120;
export const FREE_PROMPT_MIN_CHARS_DEFAULT = 80;
export const FREE_PROMPT_MAX_CHARS = 8192;
export const FREE_PROMPT_SIMHASH_MAX_DISTANCE = 6;

export function isWalletFreePromptObserveEnabled() {
  return (getSetting("wallet_free_prompt_claim_required") ?? "true") === "true";
}

export function walletFreePromptWindowSeconds() {
  const raw = Number(getSetting("wallet_free_prompt_window_seconds") ?? FREE_PROMPT_WINDOW_SECONDS_DEFAULT);
  if (!Number.isFinite(raw) || raw < 15) return FREE_PROMPT_WINDOW_SECONDS_DEFAULT;
  return Math.min(600, Math.floor(raw));
}

function flattenText(value: unknown, out: string[]) {
  if (typeof value === "string") {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenText(item, out);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") out.push(record.text);
    if (typeof record.content === "string") out.push(record.content);
    else if (record.content !== undefined) flattenText(record.content, out);
    if (record.parts !== undefined) flattenText(record.parts, out);
  }
}

export function extractPromptText(body: unknown, maxChars = FREE_PROMPT_MAX_CHARS): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const chunks: string[] = [];
  if (Array.isArray(record.messages)) {
    // Only fingerprint what the account actually asked for. Agent clients
    // (Claude Code & friends) prepend large identical system/developer
    // prompts for every user; including them drowns the user-typed signal in
    // the simhash and clusters innocent users of the same tool.
    for (const message of record.messages) {
      if (message && typeof message === "object") {
        const role = (message as Record<string, unknown>).role;
        if (typeof role === "string" && role !== "user") continue;
      }
      flattenText(message, chunks);
    }
  } else if (record.prompt !== undefined) flattenText(record.prompt, chunks);
  else if (record.input !== undefined) flattenText(record.input, chunks);
  return chunks.join("\n").slice(0, maxChars);
}

export function normalizePromptText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function hashPromptText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 64-bit SimHash over character trigrams. Stored as 16-char hex. */
export function simhashPrompt(text: string): string {
  const bits = new Array<number>(64).fill(0);
  if (text.length < 3) return "0".repeat(16);
  for (let i = 0; i < text.length - 2; i += 1) {
    const gram = text.slice(i, i + 3);
    const digest = createHash("sha256").update(gram).digest();
    for (let bit = 0; bit < 64; bit += 1) {
      const byte = digest[Math.floor(bit / 8)];
      bits[bit] += byte & (1 << (bit % 8)) ? 1 : -1;
    }
  }
  let hi = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (bits[bit] >= 0) hi |= 1n << BigInt(bit);
  }
  return hi.toString(16).padStart(16, "0");
}

export function simhashDistance(a: string, b: string): number {
  const x = BigInt(`0x${a || "0"}`) ^ BigInt(`0x${b || "0"}`);
  let n = x;
  let count = 0;
  while (n) {
    n &= n - 1n;
    count += 1;
  }
  return count;
}

export function promptsSimilar(exactA: string, hashA: string, exactB: string, hashB: string) {
  if (exactA && exactA === exactB) return true;
  return simhashDistance(hashA, hashB) <= FREE_PROMPT_SIMHASH_MAX_DISTANCE;
}

export function promptSimilarity(exactA: string, hashA: string, exactB: string, hashB: string) {
  if (exactA && exactA === exactB) return 1;
  const distance = simhashDistance(hashA, hashB);
  return Math.max(0, 1 - distance / 64);
}

export function previewPrompt(text: string, max = 280) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export type PromptObserveMeta = {
  clientIp?: string | null;
  userAgent?: string | null;
  apiKeyId?: string | null;
};

function pruneOldObservations() {
  const cutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
  db.prepare("DELETE FROM risk_prompt_observations WHERE created_at < ?").run(cutoff);
}

function addMember(groupId: string, userId: string, now: string) {
  const existing = db
    .prepare("SELECT hit_count FROM risk_group_members WHERE group_id = ? AND user_id = ?")
    .get(groupId, userId) as { hit_count: number } | undefined;
  if (existing) {
    db.prepare("UPDATE risk_group_members SET last_seen_at = ?, hit_count = hit_count + 1 WHERE group_id = ? AND user_id = ?").run(
      now,
      groupId,
      userId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO risk_group_members (group_id, user_id, first_seen_at, last_seen_at, hit_count)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(groupId, userId, now, now);
}

function refreshGroupCounts(groupId: string, now: string) {
  const counts = db
    .prepare("SELECT COUNT(*) AS members, COALESCE(SUM(hit_count), 0) AS hits FROM risk_group_members WHERE group_id = ?")
    .get(groupId) as { members: number; hits: number };
  db.prepare("UPDATE risk_groups SET member_count = ?, hit_count = ?, last_seen_at = ? WHERE id = ?").run(
    counts.members,
    counts.hits,
    now,
    groupId,
  );
}

function mergeGroups(keepId: string, dropId: string, now: string) {
  if (keepId === dropId) return keepId;
  const members = db.prepare("SELECT user_id, hit_count, first_seen_at, last_seen_at FROM risk_group_members WHERE group_id = ?").all(dropId) as Array<{
    user_id: string;
    hit_count: number;
    first_seen_at: string;
    last_seen_at: string;
  }>;
  for (const member of members) {
    const current = db
      .prepare("SELECT hit_count, first_seen_at, last_seen_at FROM risk_group_members WHERE group_id = ? AND user_id = ?")
      .get(keepId, member.user_id) as { hit_count: number; first_seen_at: string; last_seen_at: string } | undefined;
    if (!current) {
      db.prepare(
        `INSERT INTO risk_group_members (group_id, user_id, first_seen_at, last_seen_at, hit_count)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(keepId, member.user_id, member.first_seen_at, member.last_seen_at, member.hit_count);
    } else {
      db.prepare(
        `UPDATE risk_group_members
         SET hit_count = ?, first_seen_at = ?, last_seen_at = ?
         WHERE group_id = ? AND user_id = ?`,
      ).run(
        current.hit_count + member.hit_count,
        current.first_seen_at < member.first_seen_at ? current.first_seen_at : member.first_seen_at,
        current.last_seen_at > member.last_seen_at ? current.last_seen_at : member.last_seen_at,
        keepId,
        member.user_id,
      );
    }
  }
  db.prepare("DELETE FROM risk_group_members WHERE group_id = ?").run(dropId);
  db.prepare("UPDATE risk_groups SET status = 'merged', resolved_at = ? WHERE id = ?").run(now, dropId);
  refreshGroupCounts(keepId, now);
  return keepId;
}

function upsertCluster(
  model: string,
  userIds: string[],
  exactHash: string,
  preview: string,
  similarity: number,
  gapSeconds: number,
  windowSeconds: number,
  now: string,
) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length < 2) return null;
  const placeholders = unique.map(() => "?").join(",");
  const existing = db
    .prepare(
      `SELECT DISTINCT g.id, g.created_at
       FROM risk_groups g
       JOIN risk_group_members m ON m.group_id = g.id
       WHERE g.status = 'open' AND g.model = ? AND m.user_id IN (${placeholders})
       ORDER BY g.created_at ASC`,
    )
    .all(model, ...unique) as Array<{ id: string; created_at: string }>;

  let groupId = existing[0]?.id;
  if (!groupId) {
    groupId = uuid();
    db.prepare(
      `INSERT INTO risk_groups (id, model, status, reason, sample_hash, sample_preview, max_similarity, min_gap_seconds, window_seconds, member_count, hit_count, created_at, last_seen_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run(
      groupId,
      model,
      `${windowSeconds} 秒内 ${unique.length} 个账号使用高度相似的免费模型提示词（含先发起的账号）`,
      exactHash,
      preview,
      similarity,
      gapSeconds,
      windowSeconds,
      now,
      now,
    );
  }
  for (const extra of existing.slice(1)) groupId = mergeGroups(groupId, extra.id, now);
  for (const userId of unique) addMember(groupId, userId, now);
  const current = db
    .prepare("SELECT max_similarity, min_gap_seconds, sample_preview FROM risk_groups WHERE id = ?")
    .get(groupId) as { max_similarity: number; min_gap_seconds: number | null; sample_preview: string | null };
  db.prepare(
    `UPDATE risk_groups
     SET max_similarity = ?,
         min_gap_seconds = ?,
         sample_preview = COALESCE(NULLIF(sample_preview, ''), ?),
         window_seconds = COALESCE(window_seconds, ?)
     WHERE id = ?`,
  ).run(
    Math.max(Number(current.max_similarity || 0), similarity),
    current.min_gap_seconds == null ? gapSeconds : Math.min(current.min_gap_seconds, gapSeconds),
    preview,
    windowSeconds,
    groupId,
  );
  refreshGroupCounts(groupId, now);
  return groupId;
}

/** Observe only. Never blocks the request. Clusters similar wallet free-model prompts inside a short window. */
export function observeWalletFreePrompt(userId: string, model: string, body: unknown, meta: PromptObserveMeta = {}) {
  if (!isWalletFreePromptObserveEnabled()) return;
  const rawText = extractPromptText(body);
  const normalized = normalizePromptText(rawText);
  if (normalized.length < FREE_PROMPT_MIN_CHARS_DEFAULT) return;

  const exactHash = hashPromptText(normalized);
  const sim = simhashPrompt(normalized);
  const preview = previewPrompt(rawText);
  const now = nowIso();
  const windowSeconds = walletFreePromptWindowSeconds();
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const clientIp = meta.clientIp?.trim() || null;
  const userAgent = (meta.userAgent || "").slice(0, 240) || null;

  db.prepare(
    `INSERT INTO risk_prompt_observations (id, user_id, model, exact_hash, simhash, char_len, preview, client_ip, user_agent, api_key_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuid(), userId, model, exactHash, sim, normalized.length, preview, clientIp, userAgent, meta.apiKeyId ?? null, now);

  const recent = db
    .prepare(
      `SELECT user_id, exact_hash, simhash, preview, created_at FROM risk_prompt_observations
       WHERE model = ? AND created_at >= ?`,
    )
    .all(model, since) as Array<{ user_id: string; exact_hash: string; simhash: string; preview: string; created_at: string }>;

  const clustered = new Set<string>([userId]);
  const matches: Array<{ peerId: string; similarity: number; exact: boolean; gap: number; peerPreview: string }> = [];
  for (const row of recent) {
    if (row.user_id === userId) continue;
    if (!promptsSimilar(exactHash, sim, row.exact_hash, row.simhash)) continue;
    clustered.add(row.user_id);
    const similarity = promptSimilarity(exactHash, sim, row.exact_hash, row.simhash);
    const gap = Math.max(0, Math.round((Date.parse(now) - Date.parse(row.created_at)) / 1000));
    matches.push({
      peerId: row.user_id,
      similarity,
      exact: exactHash === row.exact_hash,
      gap,
      peerPreview: row.preview || "",
    });
  }
  if (clustered.size < 2 || !matches.length) {
    pruneOldObservations();
    return;
  }
  const best = matches.reduce((acc, item) => (item.similarity > acc.similarity ? item : acc), matches[0]);
  const groupId = upsertCluster(
    model,
    [...clustered],
    exactHash,
    preview,
    best.similarity,
    best.gap,
    windowSeconds,
    now,
  );
  if (groupId) {
    for (const match of matches) {
      db.prepare(
        `INSERT INTO risk_group_events (
          id, group_id, actor_user_id, peer_user_id, model, similarity, exact_match, gap_seconds,
          preview, peer_preview, client_ip, user_agent, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuid(),
        groupId,
        userId,
        match.peerId,
        model,
        match.similarity,
        match.exact ? 1 : 0,
        match.gap,
        preview,
        match.peerPreview,
        clientIp,
        userAgent,
        now,
      );
    }
  }
  pruneOldObservations();
}

/** @deprecated name kept for call-site compatibility; observation never throws. */
export function claimWalletFreePrompt(userId: string, model: string, body: unknown) {
  observeWalletFreePrompt(userId, model, body);
}

import { db } from "../db";
import { nowIso } from "../utils/time";
import { setUsersStatus } from "./users";

export type RiskGroupMember = {
  user_id: string;
  username: string;
  display_name: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
  lifetime_topup_micros: number;
  plan_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  hit_count: number;
  preview: string | null;
  client_ips: string[];
};

export type RiskGroupEvent = {
  id: string;
  created_at: string;
  actor_user_id: string;
  actor_username: string;
  peer_user_id: string;
  peer_username: string;
  similarity: number;
  exact_match: boolean;
  gap_seconds: number;
  preview: string;
  peer_preview: string;
  client_ip: string | null;
  user_agent: string | null;
};

export type RiskGroup = {
  id: string;
  model: string;
  status: string;
  reason: string;
  sample_preview: string | null;
  max_similarity: number;
  min_gap_seconds: number | null;
  window_seconds: number | null;
  member_count: number;
  hit_count: number;
  created_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_action: string | null;
  ai_score: number | null;
  ai_verdict: string | null;
  ai_analyzed_at: string | null;
  members: RiskGroupMember[];
  events: RiskGroupEvent[];
};

export type RiskRadarReport = {
  hours: number;
  generated_at: string;
  summary: { open_groups: number; members: number; resolved: number };
  groups: RiskGroup[];
};

function mapUsers(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) {
    return new Map<
      string,
      {
        username: string;
        display_name: string;
        status: string;
        created_at: string;
        last_login_at: string | null;
        lifetime_topup_micros: number;
        plan_name: string | null;
      }
    >();
  }
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.status, u.created_at, u.last_login_at,
              COALESCE(w.lifetime_topup_micros, 0) AS lifetime_topup_micros,
              p.name AS plan_name
       FROM users u
       LEFT JOIN wallet_accounts w ON w.user_id = u.id
       LEFT JOIN subscriptions s ON s.id = (
         SELECT id FROM subscriptions sx
         WHERE sx.user_id = u.id AND sx.status = 'active'
         ORDER BY sx.created_at DESC LIMIT 1
       )
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE u.id IN (${unique.map(() => "?").join(",")})`,
    )
    .all(...unique) as Array<{
      id: string;
      username: string;
      display_name: string;
      status: string;
      created_at: string;
      last_login_at: string | null;
      lifetime_topup_micros: number;
      plan_name: string | null;
    }>;
  return new Map(rows.map((row) => [row.id, row]));
}

export function listRiskRadar(hours = 72): RiskRadarReport {
  const windowHours = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const groups = db
    .prepare(
      `SELECT id, model, status, reason, sample_preview, max_similarity, min_gap_seconds, window_seconds,
              member_count, hit_count, created_at, last_seen_at, resolved_at, resolved_action,
              ai_score, ai_verdict, ai_analyzed_at
       FROM risk_groups
       WHERE last_seen_at >= ?
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen_at DESC
       LIMIT 100`,
    )
    .all(since) as Array<{
      id: string;
      model: string;
      status: string;
      reason: string;
      sample_preview: string | null;
      max_similarity: number;
      min_gap_seconds: number | null;
      window_seconds: number | null;
      member_count: number;
      hit_count: number;
      created_at: string;
      last_seen_at: string;
      resolved_at: string | null;
      resolved_action: string | null;
      ai_score: number | null;
      ai_verdict: string | null;
      ai_analyzed_at: string | null;
    }>;

  const groupIds = groups.map((g) => g.id);
  const members = groupIds.length
    ? (db
        .prepare(
          `SELECT group_id, user_id, first_seen_at, last_seen_at, hit_count
           FROM risk_group_members
           WHERE group_id IN (${groupIds.map(() => "?").join(",")})
           ORDER BY first_seen_at ASC`,
        )
        .all(...groupIds) as Array<{
        group_id: string;
        user_id: string;
        first_seen_at: string;
        last_seen_at: string;
        hit_count: number;
      }>)
    : [];
  const events = groupIds.length
    ? (db
        .prepare(
          `SELECT id, group_id, actor_user_id, peer_user_id, similarity, exact_match, gap_seconds,
                  preview, peer_preview, client_ip, user_agent, created_at
           FROM risk_group_events
           WHERE group_id IN (${groupIds.map(() => "?").join(",")})
           ORDER BY created_at DESC`,
        )
        .all(...groupIds) as Array<{
        id: string;
        group_id: string;
        actor_user_id: string;
        peer_user_id: string;
        similarity: number;
        exact_match: number;
        gap_seconds: number;
        preview: string;
        peer_preview: string;
        client_ip: string | null;
        user_agent: string | null;
        created_at: string;
      }>)
    : [];
  const userIds = [
    ...members.map((m) => m.user_id),
    ...events.flatMap((e) => [e.actor_user_id, e.peer_user_id]),
  ];
  const users = mapUsers(userIds);
  const memberPreviews = new Map<string, { preview: string; ips: Set<string> }>();
  for (const event of events) {
    const actor = memberPreviews.get(event.actor_user_id) ?? { preview: "", ips: new Set<string>() };
    if (!actor.preview && event.preview) actor.preview = event.preview;
    if (event.client_ip) actor.ips.add(event.client_ip);
    memberPreviews.set(event.actor_user_id, actor);
    const peer = memberPreviews.get(event.peer_user_id) ?? { preview: "", ips: new Set<string>() };
    if (!peer.preview && event.peer_preview) peer.preview = event.peer_preview;
    memberPreviews.set(event.peer_user_id, peer);
  }

  const membersByGroup = new Map<string, RiskGroupMember[]>();
  for (const member of members) {
    const user = users.get(member.user_id);
    const extra = memberPreviews.get(member.user_id);
    const list = membersByGroup.get(member.group_id) ?? [];
    list.push({
      user_id: member.user_id,
      username: user?.username || member.user_id.slice(0, 8),
      display_name: user?.display_name || user?.username || member.user_id.slice(0, 8),
      status: user?.status || "unknown",
      created_at: user?.created_at || "",
      last_login_at: user?.last_login_at ?? null,
      lifetime_topup_micros: Number(user?.lifetime_topup_micros || 0),
      plan_name: user?.plan_name ?? null,
      first_seen_at: member.first_seen_at,
      last_seen_at: member.last_seen_at,
      hit_count: member.hit_count,
      preview: extra?.preview || null,
      client_ips: extra ? [...extra.ips] : [],
    });
    membersByGroup.set(member.group_id, list);
  }

  const eventsByGroup = new Map<string, RiskGroupEvent[]>();
  for (const event of events) {
    const list = eventsByGroup.get(event.group_id) ?? [];
    list.push({
      id: event.id,
      created_at: event.created_at,
      actor_user_id: event.actor_user_id,
      actor_username: users.get(event.actor_user_id)?.username || event.actor_user_id.slice(0, 8),
      peer_user_id: event.peer_user_id,
      peer_username: users.get(event.peer_user_id)?.username || event.peer_user_id.slice(0, 8),
      similarity: Number(event.similarity || 0),
      exact_match: event.exact_match === 1,
      gap_seconds: event.gap_seconds,
      preview: event.preview,
      peer_preview: event.peer_preview,
      client_ip: event.client_ip,
      user_agent: event.user_agent,
    });
    eventsByGroup.set(event.group_id, list);
  }

  const mapped: RiskGroup[] = groups.map((group) => ({
    ...group,
    max_similarity: Number(group.max_similarity || 0),
    members: membersByGroup.get(group.id) ?? [],
    events: (eventsByGroup.get(group.id) ?? []).slice(0, 20),
  }));
  return {
    hours: windowHours,
    generated_at: new Date().toISOString(),
    summary: {
      open_groups: mapped.filter((g) => g.status === "open").length,
      members: new Set(mapped.filter((g) => g.status === "open").flatMap((g) => g.members.map((m) => m.user_id))).size,
      resolved: mapped.filter((g) => g.status !== "open").length,
    },
    groups: mapped,
  };
}

export function resolveRiskGroup(
  groupId: string,
  action: "disabled" | "suspended" | "ignored",
) {
  const group = db.prepare("SELECT id, status FROM risk_groups WHERE id = ?").get(groupId) as
    | { id: string; status: string }
    | undefined;
  if (!group) return null;
  const memberIds = (
    db.prepare("SELECT user_id FROM risk_group_members WHERE group_id = ?").all(groupId) as Array<{ user_id: string }>
  ).map((row) => row.user_id);
  let updated = { updated: 0, ids: [] as string[], status: action };
  if (action === "disabled" || action === "suspended") {
    updated = { ...setUsersStatus(memberIds, action), status: action };
  }
  db.prepare("UPDATE risk_groups SET status = ?, resolved_at = ?, resolved_action = ? WHERE id = ?").run(
    action === "ignored" ? "ignored" : "actioned",
    nowIso(),
    action,
    groupId,
  );
  return { ok: true, group_id: groupId, action, ...updated };
}

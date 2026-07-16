import { v4 as uuid } from "uuid";
import { db } from "../db";
import { nowIso } from "../utils/time";

export function writeAudit(input: {
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  detail?: unknown;
}) {
  db.prepare(
    `INSERT INTO admin_audit_logs (id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    input.action,
    input.target_type ?? null,
    input.target_id ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    nowIso(),
  );
}

export function listAuditLogs(limit = 200) {
  return db
    .prepare("SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

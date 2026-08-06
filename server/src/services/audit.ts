import { v4 as uuid } from "uuid";
import { db } from "../db";
import { redact } from "../utils/redact";
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
    // Never persist secrets: a password submitted via PATCH /users/:id would
    // otherwise be logged verbatim in the audit trail.
    input.detail === undefined ? null : JSON.stringify(redact(input.detail)),
    nowIso(),
  );
}

export function listAuditLogs(limit = 200) {
  // L8/L9: clamp negatives (SQLite LIMIT -1 = all rows) and tie-break on id.
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number.isFinite(limit) ? limit : 200)));
  return db
    .prepare("SELECT * FROM admin_audit_logs ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(safeLimit);
}

import { v4 as uuid } from "uuid";
import { db } from "../db";
import { nowIso } from "../utils/time";

export type FeedbackAttachment = { name: string; type: string; data: string };
type ThreadRow = { id: string; [key: string]: unknown };

const messages = (threadId: string) =>
  db.prepare("SELECT * FROM feedback_messages WHERE thread_id = ? ORDER BY created_at").all(threadId).map((row) => ({
    ...(row as Record<string, unknown>),
    attachments: JSON.parse((row as { attachments: string }).attachments || "[]"),
  }));

function mapThread(row: ThreadRow) {
  return { ...row, messages: messages(row.id as string) };
}

export function listUserFeedback(userId: string, limit = 100, offset = 0) {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM feedback_threads WHERE user_id=?").get(userId) as { n: number }).n;
  const items = (db.prepare("SELECT * FROM feedback_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(userId, limit, offset) as ThreadRow[]).map(mapThread);
  return { total, items };
}

export function listAllFeedback(limit = 100, offset = 0) {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM feedback_threads").get() as { n: number }).n;
  const items = (db.prepare("SELECT f.*, u.username, u.display_name FROM feedback_threads f JOIN users u ON u.id=f.user_id ORDER BY f.updated_at DESC LIMIT ? OFFSET ?").all(limit, offset) as ThreadRow[]).map(mapThread);
  return { total, items };
}

export function getFeedbackThread(id: string) {
  return db.prepare("SELECT * FROM feedback_threads WHERE id = ?").get(id) as { id: string; user_id: string; status: string } | undefined;
}

export function createFeedback(userId: string, subject: string, body: string, attachments: FeedbackAttachment[]) {
  const id = uuid(), now = nowIso();
  db.transaction(() => {
    db.prepare("INSERT INTO feedback_threads (id,user_id,subject,status,last_sender_type,admin_unread,user_unread,created_at,updated_at) VALUES (?,?,?,'open','user',1,0,?,?)").run(id, userId, subject, now, now);
    db.prepare("INSERT INTO feedback_messages (id,thread_id,sender_type,body,attachments,created_at) VALUES (?,?,'user',?,?,?)").run(uuid(), id, body, JSON.stringify(attachments), now);
  })();
  return mapThread(db.prepare("SELECT * FROM feedback_threads WHERE id=?").get(id) as ThreadRow);
}

/** Admin proactively creates a ticket for a user */
export function createAdminTicket(userId: string, subject: string, body: string, attachments: FeedbackAttachment[] = []) {
  const id = uuid(), now = nowIso();
  db.transaction(() => {
    db.prepare("INSERT INTO feedback_threads (id,user_id,subject,status,last_sender_type,admin_unread,user_unread,created_at,updated_at) VALUES (?,?,?,'open','admin',0,1,?,?)").run(id, userId, subject, now, now);
    db.prepare("INSERT INTO feedback_messages (id,thread_id,sender_type,body,attachments,created_at) VALUES (?,?,'admin',?,?,?)").run(uuid(), id, body, JSON.stringify(attachments), now);
  })();
  return mapThread(db.prepare("SELECT * FROM feedback_threads WHERE id=?").get(id) as ThreadRow);
}

export function replyFeedback(threadId: string, sender: "user" | "admin", body: string, attachments: FeedbackAttachment[], userId?: string) {
  const thread = db.prepare("SELECT * FROM feedback_threads WHERE id=?").get(threadId) as { id: string; user_id: string } | undefined;
  if (!thread || (userId && thread.user_id !== userId)) return null;
  const now = nowIso();
  db.transaction(() => {
    db.prepare("INSERT INTO feedback_messages (id,thread_id,sender_type,body,attachments,created_at) VALUES (?,?,?,?,?,?)").run(uuid(), threadId, sender, body, JSON.stringify(attachments), now);
    // Set last_sender + increment the other party's unread
    if (sender === "admin") {
      db.prepare("UPDATE feedback_threads SET status='open', last_sender_type='admin', admin_unread=0, user_unread=user_unread+1, updated_at=? WHERE id=?").run(now, threadId);
    } else {
      db.prepare("UPDATE feedback_threads SET status='open', last_sender_type='user', user_unread=0, admin_unread=admin_unread+1, updated_at=? WHERE id=?").run(now, threadId);
    }
  })();
  return messages(threadId);
}

export function setFeedbackStatus(threadId: string, status: string) {
  return db.prepare("UPDATE feedback_threads SET status=?, updated_at=? WHERE id=?").run(status, nowIso(), threadId).changes > 0;
}

/** Mark all messages in a thread as read by the given party */
export function markThreadRead(threadId: string, who: "admin" | "user") {
  const col = who === "admin" ? "admin_unread" : "user_unread";
  db.prepare(`UPDATE feedback_threads SET ${col}=0 WHERE id=?`).run(threadId);
}

/** Count of threads with unread user replies — for admin badge */
export function adminUnreadCount() {
  return (db.prepare("SELECT COUNT(*) AS n FROM feedback_threads WHERE admin_unread > 0 AND status='open'").get() as { n: number }).n;
}

/** Count of threads with unread admin replies — for user badge */
export function userUnreadCount(userId: string) {
  return (db.prepare("SELECT COUNT(*) AS n FROM feedback_threads WHERE user_id=? AND user_unread > 0 AND status='open'").get(userId) as { n: number }).n;
}

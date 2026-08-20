import fs from "fs";
import path from "path";
import { getDataDir } from "../db";
import { nowIso } from "../utils/time";
import { sniffBrandIcon, BrandIconError } from "./branding";

export const AVATAR_MAX_BYTES = 512 * 1024;

function avatarDir(): string {
  return path.join(getDataDir(), "avatars");
}

function avatarPath(userId: string): string {
  return path.join(avatarDir(), userId);
}

function metaKey(userId: string) {
  return { mime: `avatar_mime:${userId}`, updated: `avatar_updated_at:${userId}` };
}

export function saveUserAvatar(userId: string, buffer: Buffer): string {
  if (buffer.length > AVATAR_MAX_BYTES) {
    throw new BrandIconError(413, "Image must be 512 KB or smaller");
  }
  const kind = sniffBrandIcon(buffer);
  if (!kind) {
    throw new BrandIconError(400, "Upload a PNG, JPEG, WebP, or SVG image");
  }
  const filePath = avatarPath(userId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  const { mime, updated } = metaKey(userId);
  // Store metadata in settings table
  const { setSetting } = require("../db");
  setSetting(mime, kind.mime);
  setSetting(updated, nowIso());
  return getUserAvatarUrl(userId) || `/user/api/avatar`;
}

export function getUserAvatarUrl(userId: string): string | null {
  const { getSetting } = require("../db");
  const { updated } = metaKey(userId);
  const ts = (getSetting(updated) || "").trim();
  if (!ts || !fs.existsSync(avatarPath(userId))) return null;
  return `/user/api/avatar?t=${encodeURIComponent(ts)}`;
}

export function readUserAvatar(userId: string): { buffer: Buffer; mime: string } | null {
  const filePath = avatarPath(userId);
  if (!fs.existsSync(filePath)) return null;
  const { getSetting } = require("../db");
  const { mime } = metaKey(userId);
  const m = (getSetting(mime) || "").trim() || "application/octet-stream";
  return { buffer: fs.readFileSync(filePath), mime: m };
}

export function clearUserAvatar(userId: string): void {
  try { fs.unlinkSync(avatarPath(userId)); } catch { /* already gone */ }
  const { deleteSetting } = require("../db");
  const { mime, updated } = metaKey(userId);
  deleteSetting(mime);
  deleteSetting(updated);
}

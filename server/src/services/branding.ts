import fs from "fs";
import path from "path";
import { deleteSetting, getDataDir, getSetting, setSetting } from "../db";
import { nowIso } from "../utils/time";

export const DEFAULT_BRAND_NAME = "LocalAPI";
export const BRAND_ICON_MAX_BYTES = 512 * 1024;

export type PublicBranding = {
  brand_name: string;
  brand_tagline: string;
  company_name: string;
  public_base_url: string;
  icon_url: string | null;
};

export type PublicAnnouncement = {
  enabled: boolean;
  title: string;
  content: string;
  banner: boolean;
  popup: boolean;
  updated_at: string;
};

export type PublicBrandingPayload = PublicBranding & {
  announcement: PublicAnnouncement;
};

export class BrandIconError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getBrandName(): string {
  return (getSetting("brand_name") || "").trim() || DEFAULT_BRAND_NAME;
}

export function getCompanyName(): string {
  return (getSetting("company_name") || "").trim();
}

export function getBrandTagline(): string {
  return (getSetting("brand_tagline") || "").trim();
}

export function formatBrandTitle(name: string, tagline?: string | null): string {
  const n = name.trim() || DEFAULT_BRAND_NAME;
  const t = (tagline || "").trim();
  return t ? `${n} ${t}` : n;
}

export function getBrandIconPath(): string {
  return path.join(getDataDir(), "brand", "icon");
}

export function getBrandIconUrl(): string | null {
  const updated = (getSetting("brand_icon_updated_at") || "").trim();
  if (!updated || !fs.existsSync(getBrandIconPath())) return null;
  return `/branding/icon?v=${encodeURIComponent(updated)}`;
}

export function getPublicBranding(): PublicBranding {
  return {
    brand_name: getBrandName(),
    brand_tagline: getBrandTagline(),
    company_name: getCompanyName(),
    public_base_url: (getSetting("public_base_url") || "").trim(),
    icon_url: getBrandIconUrl(),
  };
}

export function getPublicBrandingPayload(): PublicBrandingPayload {
  const announcementEnabled = (getSetting("announcement_enabled") ?? "false") === "true";
  const announcementContent = (getSetting("announcement_content") || "").trim();
  return {
    ...getPublicBranding(),
    announcement:
      announcementEnabled && announcementContent
        ? {
            enabled: true,
            title: (getSetting("announcement_title") || "").trim() || "公告",
            content: announcementContent,
            banner: (getSetting("announcement_banner") ?? "true") === "true",
            popup: (getSetting("announcement_popup") ?? "true") === "true",
            updated_at: getSetting("announcement_updated_at") || "",
          }
        : {
            enabled: false,
            title: "",
            content: "",
            banner: false,
            popup: false,
            updated_at: "",
          },
  };
}

export function sniffBrandIcon(buffer: Buffer): { mime: string } | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: "image/png" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg" };
  }
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mime: "image/webp" };
  }
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return { mime: "image/x-icon" };
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 256)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml\b[^>]*>\s*)?<svg\b/i.test(head)) {
    const text = buffer.toString("utf8");
    if (/<script\b/i.test(text) || /\bon\w+\s*=/i.test(text) || /javascript:/i.test(text)) return null;
    return { mime: "image/svg+xml" };
  }
  return null;
}

export function saveBrandIcon(buffer: Buffer): string {
  if (buffer.length > BRAND_ICON_MAX_BYTES) {
    throw new BrandIconError(413, "Image must be 512 KB or smaller");
  }
  const kind = sniffBrandIcon(buffer);
  if (!kind) {
    throw new BrandIconError(400, "Upload a PNG, JPEG, WebP, SVG, or ICO image");
  }
  const filePath = getBrandIconPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  setSetting("brand_icon_mime", kind.mime);
  setSetting("brand_icon_updated_at", nowIso());
  return getBrandIconUrl() || "/branding/icon";
}

export function clearBrandIcon() {
  try {
    fs.unlinkSync(getBrandIconPath());
  } catch {
    // already gone
  }
  deleteSetting("brand_icon_mime");
  deleteSetting("brand_icon_updated_at");
}

export function readBrandIcon(): { buffer: Buffer; mime: string } | null {
  const filePath = getBrandIconPath();
  if (!fs.existsSync(filePath)) return null;
  const mime = (getSetting("brand_icon_mime") || "").trim() || "application/octet-stream";
  return { buffer: fs.readFileSync(filePath), mime };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON that is safe to embed in a <script> tag. */
export function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const BOOT_PLACEHOLDER = "/*__LOCALAPI_BRANDING__*/{}";

/**
 * Stamp the configured brand onto the SPA shell so the first paint
 * (tab title + window.__LOCALAPI_BRANDING__) never shows the default
 * after an operator has set a brand name.
 */
export function applyBrandingToHtml(
  html: string,
  branding: Pick<PublicBranding, "brand_name" | "company_name"> & {
    brand_tagline?: string;
    icon_url?: string | null;
  } = getPublicBranding(),
): string {
  const iconUrl = branding.icon_url ?? null;
  const tagline = branding.brand_tagline ?? "";
  const payload = jsonForInlineScript({
    brand_name: branding.brand_name,
    brand_tagline: tagline,
    company_name: branding.company_name,
    icon_url: iconUrl,
  });
  let next = html.replace(
    /<title>[^<]*<\/title>/i,
    `<title>${escapeHtml(formatBrandTitle(branding.brand_name, tagline))}</title>`,
  );
  if (iconUrl) {
    next = next.replace(
      /<link\s+rel="icon"[^>]*>/i,
      `<link rel="icon" href="${escapeHtml(iconUrl)}" />`,
    );
  }
  if (next.includes(BOOT_PLACEHOLDER)) {
    return next.replace(BOOT_PLACEHOLDER, payload);
  }
  return next.replace(
    /<head([^>]*)>/i,
    `<head$1><script>window.__LOCALAPI_BRANDING__=${payload};</script>`,
  );
}

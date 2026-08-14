import { getSetting } from "../db";

export const DEFAULT_BRAND_NAME = "LocalAPI";

export type PublicBranding = {
  brand_name: string;
  company_name: string;
  public_base_url: string;
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

export function getBrandName(): string {
  return (getSetting("brand_name") || "").trim() || DEFAULT_BRAND_NAME;
}

export function getCompanyName(): string {
  return (getSetting("company_name") || "").trim();
}

export function getPublicBranding(): PublicBranding {
  return {
    brand_name: getBrandName(),
    company_name: getCompanyName(),
    public_base_url: (getSetting("public_base_url") || "").trim(),
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
  branding: Pick<PublicBranding, "brand_name" | "company_name"> = {
    brand_name: getBrandName(),
    company_name: getCompanyName(),
  },
): string {
  const payload = jsonForInlineScript({
    brand_name: branding.brand_name,
    company_name: branding.company_name,
  });
  const titled = html.replace(
    /<title>[^<]*<\/title>/i,
    `<title>${escapeHtml(branding.brand_name)}</title>`,
  );
  if (titled.includes(BOOT_PLACEHOLDER)) {
    return titled.replace(BOOT_PLACEHOLDER, payload);
  }
  return titled.replace(
    /<head([^>]*)>/i,
    `<head$1><script>window.__LOCALAPI_BRANDING__=${payload};</script>`,
  );
}

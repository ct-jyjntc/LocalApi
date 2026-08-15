import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const DEFAULT_BRAND_NAME = "LocalAPI";
export const BRAND_CACHE_KEY = "localapi_brand_name";
export const COMPANY_CACHE_KEY = "localapi_company_name";
export const TAGLINE_CACHE_KEY = "localapi_brand_tagline";
export const ICON_CACHE_KEY = "localapi_brand_icon_url";
export const BRANDING_QUERY_KEY = ["branding"] as const;

export type BootBranding = {
  brand_name?: string;
  brand_tagline?: string;
  company_name?: string;
  icon_url?: string | null;
};

declare global {
  interface Window {
    __LOCALAPI_BRANDING__?: BootBranding;
  }
}

export function bootBranding(): BootBranding {
  if (typeof window === "undefined") return {};
  return window.__LOCALAPI_BRANDING__ ?? {};
}

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() || "";
  } catch {
    return "";
  }
}

export function formatBrandTitle(name: string, tagline?: string | null): string {
  const n = name.trim() || DEFAULT_BRAND_NAME;
  const t = (tagline || "").trim();
  return t ? `${n} ${t}` : n;
}

export function resolveBrandName(live?: string | null, fallback = DEFAULT_BRAND_NAME): string {
  const fromLive = live?.trim();
  if (fromLive) return fromLive;
  const fromBoot = bootBranding().brand_name?.trim();
  if (fromBoot) return fromBoot;
  return readStorage(BRAND_CACHE_KEY) || fallback;
}

export function resolveCompanyName(live?: string | null): string {
  const fromLive = live?.trim();
  if (fromLive) return fromLive;
  const fromBoot = bootBranding().company_name?.trim();
  if (fromBoot) return fromBoot;
  return readStorage(COMPANY_CACHE_KEY);
}

export function resolveTagline(live?: string | null): string {
  if (live === null) return "";
  if (live !== undefined) return live.trim();
  const fromBoot = bootBranding().brand_tagline?.trim();
  if (fromBoot) return fromBoot;
  return readStorage(TAGLINE_CACHE_KEY);
}

export function resolveIconUrl(live?: string | null): string {
  if (live === null) return "";
  const fromLive = live?.trim();
  if (fromLive) return fromLive;
  const fromBoot = bootBranding().icon_url?.trim();
  if (fromBoot) return fromBoot;
  return readStorage(ICON_CACHE_KEY);
}

export function applyFavicon(iconUrl: string) {
  if (typeof document === "undefined") return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (iconUrl) {
    link.href = iconUrl;
    link.removeAttribute("type");
    return;
  }
  link.href = "/favicon.svg";
  link.type = "image/svg+xml";
}

export function persistBranding(input: {
  brandName: string;
  companyName?: string | null;
  tagline?: string | null;
  iconUrl?: string | null;
}) {
  const name = input.brandName.trim() || DEFAULT_BRAND_NAME;
  const company = input.companyName?.trim() || "";
  const tagline = input.tagline === undefined ? resolveTagline() : input.tagline?.trim() || "";
  const icon = input.iconUrl === undefined ? resolveIconUrl() : input.iconUrl?.trim() || "";
  try {
    localStorage.setItem(BRAND_CACHE_KEY, name);
    if (company) localStorage.setItem(COMPANY_CACHE_KEY, company);
    else localStorage.removeItem(COMPANY_CACHE_KEY);
    if (tagline) localStorage.setItem(TAGLINE_CACHE_KEY, tagline);
    else localStorage.removeItem(TAGLINE_CACHE_KEY);
    if (icon) localStorage.setItem(ICON_CACHE_KEY, icon);
    else localStorage.removeItem(ICON_CACHE_KEY);
  } catch {
    // private mode / blocked storage
  }
  if (typeof window !== "undefined") {
    window.__LOCALAPI_BRANDING__ = {
      brand_name: name,
      brand_tagline: tagline,
      company_name: company,
      icon_url: icon || null,
    };
  }
  applyDocumentTitle(formatBrandTitle(name, tagline));
  applyFavicon(icon);
}

export function applyDocumentTitle(title: string) {
  if (title && typeof document !== "undefined") {
    document.title = title;
  }
}

/** Live /branding first, then the HTML boot payload / local cache. */
export function useBrand() {
  const branding = useQuery({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: api.branding,
    staleTime: 60_000,
  });
  const brandName = resolveBrandName(branding.data?.brand_name);
  const companyName = resolveCompanyName(branding.data?.company_name);
  const tagline = resolveTagline(branding.data ? branding.data.brand_tagline ?? null : undefined);
  const iconUrl = resolveIconUrl(branding.data ? branding.data.icon_url ?? null : undefined);

  useEffect(() => {
    if (!branding.data) return;
    persistBranding({
      brandName: branding.data.brand_name,
      companyName: branding.data.company_name,
      tagline: branding.data.brand_tagline ?? "",
      iconUrl: branding.data.icon_url ?? null,
    });
  }, [branding.data]);

  useEffect(() => {
    applyDocumentTitle(formatBrandTitle(brandName, tagline));
  }, [brandName, tagline]);

  useEffect(() => {
    applyFavicon(iconUrl);
  }, [iconUrl]);

  return { branding, brandName, companyName, tagline, iconUrl };
}

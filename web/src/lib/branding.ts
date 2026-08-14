import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const DEFAULT_BRAND_NAME = "LocalAPI";
export const BRAND_CACHE_KEY = "localapi_brand_name";
export const COMPANY_CACHE_KEY = "localapi_company_name";
export const BRANDING_QUERY_KEY = ["branding"] as const;

export type BootBranding = {
  brand_name?: string;
  company_name?: string;
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

export function persistBranding(brandName: string, companyName?: string | null) {
  const name = brandName.trim() || DEFAULT_BRAND_NAME;
  const company = companyName?.trim() || "";
  try {
    localStorage.setItem(BRAND_CACHE_KEY, name);
    if (company) localStorage.setItem(COMPANY_CACHE_KEY, company);
    else localStorage.removeItem(COMPANY_CACHE_KEY);
  } catch {
    // private mode / blocked storage
  }
  if (typeof window !== "undefined") {
    window.__LOCALAPI_BRANDING__ = { brand_name: name, company_name: company };
  }
  applyDocumentTitle(name);
}

export function applyDocumentTitle(brandName: string) {
  if (brandName && typeof document !== "undefined") {
    document.title = brandName;
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

  useEffect(() => {
    if (!branding.data) return;
    persistBranding(branding.data.brand_name, branding.data.company_name);
  }, [branding.data]);

  useEffect(() => {
    applyDocumentTitle(brandName);
  }, [brandName]);

  return { branding, brandName, companyName };
}

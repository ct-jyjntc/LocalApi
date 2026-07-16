import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChartNoAxesCombined,
  BookOpenText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  ScrollText,
  Tags,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n, type Locale, type MessageKey } from "@/lib/i18n";

type NavItem = {
  to: string;
  labelKey?: MessageKey;
  label?: { zh: string; en: string };
  icon: typeof LayoutDashboard;
  end?: boolean;
};

const ADMIN_NAV: NavItem[] = [
  { to: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, end: true },
  { to: "/providers", labelKey: "nav.providers", icon: Server },
  { to: "/keys", labelKey: "nav.keys", icon: KeyRound },
  { to: "/users", label: { zh: "用户", en: "Users" }, icon: Users },
  { to: "/pricing", label: { zh: "模型价格", en: "Pricing" }, icon: Tags },
  { to: "/plans", label: { zh: "套餐", en: "Plans" }, icon: Package },
  { to: "/billing", label: { zh: "计费用量", en: "Billing" }, icon: ChartNoAxesCombined },
  { to: "/logs", labelKey: "nav.logs", icon: ScrollText },
  { to: "/docs", labelKey: "nav.docs", icon: BookOpenText },
  { to: "/settings", labelKey: "nav.settings", icon: Settings },
];

const USER_NAV: NavItem[] = [
  { to: "/", label: { zh: "概览", en: "Overview" }, icon: LayoutDashboard, end: true },
  { to: "/keys", labelKey: "nav.keys", icon: KeyRound },
  { to: "/usage", label: { zh: "用量与账单", en: "Usage" }, icon: ChartNoAxesCombined },
  { to: "/docs", labelKey: "nav.docs", icon: BookOpenText },
];

const COLLAPSE_KEY = "localapi_sidebar_collapsed";

export function AppShell({ mode = "admin", onLogout }: { mode?: "admin" | "user"; onLogout?: () => void }) {
  const { t, locale } = useI18n();
  const branding = useQuery({ queryKey: ["branding"], queryFn: api.branding, staleTime: 60_000 });
  const brandName = branding.data?.brand_name || t("shell.brand");
  const companyName = branding.data?.company_name?.trim() || "";
  const nav = mode === "admin" ? ADMIN_NAV : USER_NAV;
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.title = brandName;
  }, [brandName]);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 1024) setMobileOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const width = collapsed ? 68 : 240;

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden h-screen flex-col bg-sidebar py-6 transition-[width] duration-200 ease-out lg:flex"
        style={{ width }}
      >
        <SidebarChrome
          brand={brandName}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          expandLabel={t("shell.expand")}
          collapseLabel={t("shell.collapse")}
        />
        <SidebarNav
          collapsed={collapsed}
          onNavigate={() => undefined}
          t={t}
          locale={locale}
          items={nav}
        />
        <SidebarStatus
          collapsed={collapsed}
          onLogout={onLogout}
          logoutLabel={locale === "zh" ? "退出登录" : "Sign out"}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-foreground/20"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-[min(240px,calc(100vw-2rem))] flex-col bg-sidebar py-6 shadow-lg">
            <div className="flex h-8 shrink-0 items-center gap-1 px-3">
              <span className="min-w-0 flex-1 truncate px-0.5 text-sm font-semibold">
                {brandName}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setMobileOpen(false)}
                aria-label="Close"
              >
                <X strokeWidth={1.8} />
              </Button>
            </div>
            <SidebarNav
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
              t={t}
              locale={locale}
              items={nav}
            />
            <SidebarStatus
              collapsed={false}
              onLogout={onLogout}
              logoutLabel={locale === "zh" ? "退出登录" : "Sign out"}
            />
          </aside>
        </div>
      ) : null}

      <div
        className="flex min-h-screen flex-col transition-[padding] duration-200 ease-out lg:pl-[var(--shell-sidebar-width)]"
        style={
          {
            ["--shell-sidebar-width" as string]: `${width}px`,
          } as CSSProperties
        }
      >
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border/60 bg-background/90 px-4 backdrop-blur lg:hidden">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={() => setMobileOpen(true)}
            aria-label={t("shell.menu")}
          >
            <Menu strokeWidth={1.8} />
          </Button>
          <span className="text-sm font-semibold">{brandName}</span>
        </header>

        <main className="mx-auto w-full max-w-[1280px] flex-1 min-w-0 px-3 py-5 pb-10 sm:px-8 sm:py-8">
          <Outlet />
        </main>
        {companyName ? (
          <div className="pointer-events-none fixed bottom-3 left-3 right-3 z-10 text-center text-[11px] text-muted-foreground/75 sm:left-auto sm:right-5 sm:text-right">
            @{new Date().getFullYear()} {companyName}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SidebarChrome({
  brand,
  collapsed,
  onToggle,
  expandLabel,
  collapseLabel,
}: {
  brand: string;
  collapsed: boolean;
  onToggle: () => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 px-3",
        collapsed && "justify-center px-2",
      )}
    >
      {!collapsed ? (
        <span className="min-w-0 flex-1 truncate px-0.5 text-sm font-semibold">
          {brand}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        aria-label={collapsed ? expandLabel : collapseLabel}
        title={collapsed ? expandLabel : collapseLabel}
      >
        {collapsed ? (
          <PanelLeftOpen strokeWidth={1.8} />
        ) : (
          <PanelLeftClose strokeWidth={1.8} />
        )}
      </Button>
    </div>
  );
}

function SidebarNav({
  collapsed,
  onNavigate,
  t,
  locale,
  items,
}: {
  collapsed: boolean;
  onNavigate: () => void;
  t: (key: MessageKey) => string;
  locale: Locale;
  items: NavItem[];
}) {
  return (
    <nav className="mt-6 flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
      {items.map((item) => {
        const label = item.labelKey ? t(item.labelKey) : item.label?.[locale] || item.to;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            title={collapsed ? label : undefined}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/55 hover:text-foreground",
                isActive && "bg-secondary/60 text-foreground",
                collapsed && "justify-center px-0",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className="size-4 shrink-0"
                  strokeWidth={1.75}
                  fill={isActive ? "currentColor" : "none"}
                  fillOpacity={isActive ? 0.14 : 0}
                />
                {!collapsed ? <span className="truncate">{label}</span> : null}
              </>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function SidebarStatus({
  collapsed,
  onLogout,
  logoutLabel,
}: {
  collapsed: boolean;
  onLogout?: () => void;
  logoutLabel: string;
}) {
  if (!onLogout) return null;
  return (
    <div className="mt-4 shrink-0 px-2">
      <Button
        type="button"
        variant="ghost"
        onClick={onLogout}
        title={logoutLabel}
        aria-label={logoutLabel}
        className={cn(
          "h-8 w-full justify-start gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-secondary/55 hover:text-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
        {!collapsed ? <span>{logoutLabel}</span> : null}
      </Button>
    </div>
  );
}

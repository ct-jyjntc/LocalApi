import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  CalendarCheck2,
  ChartNoAxesCombined,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  PanelsTopLeft,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  ScrollText,
  Tags,
  ShieldAlert,
  ShieldCheck,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import { Suspense, useEffect, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { userApi } from "@/lib/api";
import { AnnouncementHost } from "@/components/AnnouncementHost";
import { useI18n, type Locale, type MessageKey } from "@/lib/i18n";
import { useBrand } from "@/lib/branding";
import { BrandGlyph, BrandMark } from "@/components/BrandMark";

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
  { to: "/proxies", labelKey: "nav.proxies", icon: Waypoints },
  { to: "/users", label: { zh: "用户", en: "Users" }, icon: Users },
  { to: "/risk", label: { zh: "风控雷达", en: "Risk radar" }, icon: ShieldAlert },
  { to: "/pricing", label: { zh: "模型配置", en: "Model config" }, icon: Tags },
  { to: "/plans", label: { zh: "套餐", en: "Plans" }, icon: Package },
  { to: "/tiers", label: { zh: "用户层级", en: "User tiers" }, icon: ShieldCheck },
  { to: "/billing", label: { zh: "计费用量", en: "Billing" }, icon: ChartNoAxesCombined },
  { to: "/payments", label: { zh: "支付订单", en: "Payments" }, icon: CreditCard },
  { to: "/modules", label: { zh: "模块", en: "Modules" }, icon: Blocks },
  { to: "/logs", labelKey: "nav.logs", icon: ScrollText },
  { to: "/feedback", label: { zh: "用户反馈", en: "Feedback" }, icon: MessageSquareText },
  { to: "/settings", labelKey: "nav.settings", icon: Settings },
];

const USER_NAV: NavItem[] = [
  { to: "/", label: { zh: "概览", en: "Overview" }, icon: LayoutDashboard, end: true },
  { to: "/models", label: { zh: "模型广场", en: "Models" }, icon: PanelsTopLeft },
  { to: "/keys", labelKey: "nav.keys", icon: KeyRound },
  { to: "/plan", label: { zh: "套餐详情", en: "Plan details" }, icon: Package },
  { to: "/usage", label: { zh: "账单与订单", en: "Billing" }, icon: ChartNoAxesCombined },
  { to: "/payments", label: { zh: "账户充值", en: "Top up" }, icon: CreditCard },
  { to: "/checkin", label: { zh: "每日签到", en: "Check-in" }, icon: CalendarCheck2 },
  { to: "/settings", label: { zh: "个人设置", en: "Settings" }, icon: Settings },
];

const COLLAPSE_KEY = "localapi_sidebar_collapsed";

export function AppShell({ mode = "admin", onLogout }: { mode?: "admin" | "user"; onLogout?: () => void }) {
  const { t, locale } = useI18n();
  const { brandName, companyName, tagline, iconUrl } = useBrand();
  // User-console feature flags (check-in, etc.) — keep in sync with admin settings.
  const userConfig = useQuery({
    queryKey: ["user-config"],
    queryFn: userApi.config,
    staleTime: 30_000,
    enabled: mode === "user",
  });
  const checkinEnabled = userConfig.data?.checkin_enabled !== false;
  const nav =
    mode === "admin"
      ? ADMIN_NAV
      : USER_NAV.filter((item) => (item.to === "/checkin" ? checkinEnabled : true));
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  });
  const [mobileOpen, setMobileOpen] = useState(false);

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
          tagline={tagline}
          iconUrl={iconUrl}
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
          feedback={mode === "user" ? { to: "/feedback", label: locale === "zh" ? "我的反馈" : "My feedback" } : undefined}
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
              <span className="min-w-0 flex-1 px-0.5">
                <BrandMark name={brandName} tagline={tagline} iconUrl={iconUrl} />
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
              feedback={mode === "user" ? { to: "/feedback", label: locale === "zh" ? "我的反馈" : "My feedback" } : undefined}
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
          <BrandMark name={brandName} tagline={tagline} iconUrl={iconUrl} />
        </header>

        <AnnouncementHost />

        <main className="mx-auto w-full max-w-[1280px] flex-1 min-w-0 px-3 py-5 pb-10 sm:px-8 sm:py-8">
          <Suspense
            fallback={
              <div className="flex min-h-[40vh] items-center justify-center text-xs text-muted-foreground">
                …
              </div>
            }
          >
            <Outlet />
          </Suspense>
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

function SidebarIconToggle({
  collapsed,
  iconUrl,
  onToggle,
  label,
}: {
  collapsed: boolean;
  iconUrl?: string | null;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      className="group relative flex size-6 shrink-0 items-center justify-center rounded-md text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-3.5 w-5 object-contain object-center dark:invert" />
        ) : (
          <BrandGlyph className="h-3.5 w-5" />
        )}
      </span>
      <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
        {collapsed ? (
          <PanelLeftOpen className="size-3.5" strokeWidth={1.8} />
        ) : (
          <PanelLeftClose className="size-3.5" strokeWidth={1.8} />
        )}
      </span>
    </button>
  );
}

function SidebarChrome({
  brand,
  tagline,
  iconUrl,
  collapsed,
  onToggle,
  expandLabel,
  collapseLabel,
}: {
  brand: string;
  tagline?: string | null;
  iconUrl?: string | null;
  collapsed: boolean;
  onToggle: () => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  const toggle = (
    <SidebarIconToggle
      collapsed={collapsed}
      iconUrl={iconUrl}
      onToggle={onToggle}
      label={collapsed ? expandLabel : collapseLabel}
    />
  );

  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center px-3",
        collapsed && "justify-center px-2",
      )}
    >
      {collapsed ? toggle : (
        <BrandMark name={brand} tagline={tagline} iconUrl={iconUrl} leading={toggle} />
      )}
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
  feedback,
}: {
  collapsed: boolean;
  onLogout?: () => void;
  logoutLabel: string;
  feedback?: { to: string; label: string };
}) {
  if (!onLogout) return null;
  return (
    <div className="mt-4 shrink-0 px-2">
      {feedback ? <NavLink to={feedback.to} title={feedback.label} className={({isActive})=>cn("mb-1 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/55 hover:text-foreground",isActive&&"bg-secondary/60 text-foreground",collapsed&&"justify-center px-0")}><MessageSquareText className="size-4 shrink-0" strokeWidth={1.75}/>{!collapsed?<span>{feedback.label}</span>:null}</NavLink>:null}
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

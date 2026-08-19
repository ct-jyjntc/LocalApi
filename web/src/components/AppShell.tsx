import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  BookOpen,
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
  ReceiptText,
  Server,
  Settings,
  ScrollText,
  Tags,
  ShieldAlert,
  ShieldCheck,
  Users,
  WalletCards,
  Waypoints,
  X,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
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

type NavGroup = {
  key: string;
  label: { zh: string; en: string };
  items: NavItem[];
};

const ADMIN_NAV: NavGroup[] = [
  {
    key: "console",
    label: { zh: "控制台", en: "Console" },
    items: [
      { to: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, end: true },
      { to: "/risk", label: { zh: "风控雷达", en: "Risk radar" }, icon: ShieldAlert },
      { to: "/logs", labelKey: "nav.logs", icon: ScrollText },
    ],
  },
  {
    key: "access",
    label: { zh: "接入", en: "Access" },
    items: [
      { to: "/providers", labelKey: "nav.providers", icon: Server },
      { to: "/proxies", labelKey: "nav.proxies", icon: Waypoints },
      { to: "/keys", labelKey: "nav.keys", icon: KeyRound },
      { to: "/modules", label: { zh: "模块", en: "Modules" }, icon: Blocks },
    ],
  },
  {
    key: "commerce",
    label: { zh: "商业化", en: "Commerce" },
    items: [
      { to: "/pricing", label: { zh: "模型配置", en: "Model config" }, icon: Tags },
      { to: "/plans", label: { zh: "套餐", en: "Plans" }, icon: Package },
      { to: "/tiers", label: { zh: "用户层级", en: "User tiers" }, icon: ShieldCheck },
      { to: "/billing", label: { zh: "计费用量", en: "Billing" }, icon: ChartNoAxesCombined },
      { to: "/payments", label: { zh: "支付订单", en: "Payments" }, icon: CreditCard },
    ],
  },
  {
    key: "users",
    label: { zh: "用户", en: "Users" },
    items: [
      { to: "/users", label: { zh: "用户", en: "Users" }, icon: Users },
      { to: "/feedback", label: { zh: "用户反馈", en: "Feedback" }, icon: MessageSquareText },
    ],
  },
  {
    key: "system",
    label: { zh: "系统", en: "System" },
    items: [{ to: "/settings", labelKey: "nav.settings", icon: Settings }],
  },
];

const USER_NAV: NavGroup[] = [
  {
    key: "console",
    label: { zh: "控制台", en: "Console" },
    items: [
      { to: "/", label: { zh: "概览", en: "Overview" }, icon: LayoutDashboard, end: true },
      { to: "/checkin", label: { zh: "每日签到", en: "Check-in" }, icon: CalendarCheck2 },
    ],
  },
  {
    key: "models",
    label: { zh: "模型广场", en: "Models" },
    items: [{ to: "/models", label: { zh: "模型广场", en: "Models" }, icon: PanelsTopLeft }],
  },
  {
    key: "subscription",
    label: { zh: "订阅", en: "Subscription" },
    items: [
      { to: "/plan", label: { zh: "套餐详情", en: "Plan details" }, icon: Package },
      { to: "/payments", label: { zh: "账户充值", en: "Top up" }, icon: CreditCard },
    ],
  },
  {
    key: "docs",
    label: { zh: "文档", en: "Docs" },
    items: [{ to: "/docs", label: { zh: "使用文档", en: "Docs" }, icon: BookOpen }],
  },
  {
    key: "billing",
    label: { zh: "账单", en: "Billing" },
    items: [
      { to: "/orders", label: { zh: "订单", en: "Orders" }, icon: ReceiptText },
      { to: "/usage", label: { zh: "用量明细", en: "Usage" }, icon: ChartNoAxesCombined },
      { to: "/ledger", label: { zh: "钱包流水", en: "Wallet" }, icon: WalletCards },
    ],
  },
  {
    key: "account",
    label: { zh: "账户", en: "Account" },
    items: [
      { to: "/keys", labelKey: "nav.keys", icon: KeyRound },
      { to: "/feedback", label: { zh: "我的反馈", en: "My feedback" }, icon: MessageSquareText },
      { to: "/settings", label: { zh: "个人设置", en: "Settings" }, icon: Settings },
    ],
  },
];

/** A group is active when the current route hits any of its items. */
function groupMatches(group: NavGroup, pathname: string) {
  return group.items.some((item) =>
    item.to === "/" ? pathname === "/" : pathname.startsWith(item.to),
  );
}

const COLLAPSE_KEY = "localapi_sidebar_collapsed";

export function AppShell({ mode = "admin", onLogout }: { mode?: "admin" | "user"; onLogout?: () => void }) {
  const { t, locale } = useI18n();
  const { brandName, companyName, tagline, iconUrl } = useBrand();
  const location = useLocation();
  // User-console feature flags (check-in, etc.) — keep in sync with admin settings.
  const userConfig = useQuery({
    queryKey: ["user-config"],
    queryFn: userApi.config,
    staleTime: 30_000,
    enabled: mode === "user",
  });
  const checkinEnabled = userConfig.data?.checkin_enabled !== false;
  const groups = useMemo(() => {
    const source = mode === "admin" ? ADMIN_NAV : USER_NAV;
    return source
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => (item.to === "/checkin" ? checkinEnabled : true)),
      }))
      .filter((group) => group.items.length > 0);
  }, [mode, checkinEnabled]);
  const activeGroup = groups.find((group) => groupMatches(group, location.pathname)) || groups[0];
  // Single-page groups (e.g. 模型广场/文档) get no sidebar — the page stands alone.
  const showSidebar = Boolean(activeGroup && activeGroup.items.length > 1);
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

  const logoutLabel = locale === "zh" ? "退出登录" : "Sign out";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      {/* Top bar: brand + primary (level-1) nav + session actions — sits openly on the canvas, no chrome */}
      <header className="flex h-14 shrink-0 items-center gap-2 bg-canvas px-3 sm:gap-4 sm:px-5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label={t("shell.menu")}
        >
          <Menu strokeWidth={1.8} />
        </Button>
        {/* Brand block keeps a fixed w-52 on desktop so the primary nav never shifts,
            whether the sidebar is collapsed or absent. The collapse toggle lives inside
            the brand glyph (hover to reveal), like the pre-redesign shell. */}
        <div className="flex min-w-0 shrink-0 items-center lg:w-52">
          <BrandMark
            name={brandName}
            tagline={tagline}
            iconUrl={iconUrl}
            leading={
              showSidebar ? (
                <BrandCollapseToggle
                  collapsed={collapsed}
                  iconUrl={iconUrl}
                  onToggle={() => setCollapsed((v) => !v)}
                  label={collapsed ? t("shell.expand") : t("shell.collapse")}
                />
              ) : undefined
            }
          />
        </div>
        <nav className="hidden h-full items-center gap-1 lg:flex" aria-label={locale === "zh" ? "主导航" : "Primary"}>
          {groups.map((group) => {
            const active = group.key === activeGroup?.key;
            return (
              <Link
                key={group.key}
                to={group.items[0].to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center rounded-full px-3.5 text-sm transition-colors",
                  active
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {group.label[locale]}
              </Link>
            );
          })}
        </nav>
        {onLogout ? (
          <div className="ml-auto flex items-center gap-1">
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onLogout}
              aria-label={logoutLabel}
              className="gap-2 text-muted-foreground hover:text-foreground"
            >
              <LogOut className="size-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{logoutLabel}</span>
            </Button>
          </div>
        ) : null}
      </header>

      <AnnouncementHost />

      {/* Viewport-locked shell: only the content panel (and the sidebar rail as a
          fallback) scrolls; the outer page never does. */}
      <div className="flex min-h-0 flex-1">
        {/* Secondary (level-2) nav for the active group; hidden for single-page groups */}
        {showSidebar ? (
          <aside
            className={cn(
              "hidden h-full shrink-0 flex-col overflow-y-auto py-4 transition-[width] duration-200 ease-out lg:flex",
              collapsed ? "w-12" : "w-52",
            )}
          >
            {!collapsed && activeGroup ? (
              <p className="px-[22px] pb-2 text-[11px] text-muted-foreground">{activeGroup.label[locale]}</p>
            ) : null}
            <SidebarNav items={activeGroup?.items || []} collapsed={collapsed} flushRight onNavigate={() => undefined} t={t} locale={locale} />
          </aside>
        ) : null}

        {/* Rounded content panel floating on the muted canvas — the scroll container.
            No top padding: the topbar's own bottom inset doubles as the gap, so the
            whitespace above and below the nav pills stays symmetric. */}
        <main className="min-w-0 flex-1 overflow-hidden px-2 pb-2 sm:px-3 sm:pb-3">
          <div className="h-full overflow-y-auto rounded-xl border border-border/60 bg-background">
            <div className="mx-auto w-full max-w-[1280px] px-3 py-5 pb-10 sm:px-8 sm:py-8">
              <Suspense
                fallback={
                  <div className="flex min-h-[40vh] items-center justify-center text-xs text-muted-foreground">
                    …
                  </div>
                }
              >
                <Outlet />
              </Suspense>
            </div>
          </div>
        </main>
      </div>

      {/* Mobile drawer: full grouped nav */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-foreground/20"
            aria-label="Close menu"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-[min(260px,calc(100vw-2rem))] flex-col bg-background shadow-lg">
            <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border/60 px-3">
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
            <nav className="flex-1 overflow-y-auto px-3 py-4">
              {groups.map((group) => (
                <div key={group.key} className="mb-4 last:mb-0">
                  <p className="px-2.5 pb-1.5 text-[11px] text-muted-foreground">{group.label[locale]}</p>
                  <SidebarNav items={group.items} onNavigate={() => setMobileOpen(false)} t={t} locale={locale} />
                </div>
              ))}
            </nav>
            {onLogout ? (
              <div className="shrink-0 border-t border-border/60 p-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onLogout}
                  aria-label={logoutLabel}
                  className="h-8 w-full justify-start gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-secondary/55 hover:text-foreground"
                >
                  <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
                  <span>{logoutLabel}</span>
                </Button>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}

      {companyName ? (
        <div className="pointer-events-none fixed bottom-3 left-3 right-3 z-10 text-center text-[11px] text-muted-foreground/75 sm:left-auto sm:right-5 sm:text-right">
          @{new Date().getFullYear()} {companyName}
        </div>
      ) : null}
    </div>
  );
}

/** Brand glyph that reveals a sidebar collapse/expand icon on hover (pre-redesign behavior). */
function BrandCollapseToggle({
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
      className="group relative -mx-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-5 object-contain object-center dark:invert" />
        ) : (
          <BrandGlyph className="size-5" />
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

function SidebarNav({
  onNavigate,
  t,
  locale,
  items,
  collapsed = false,
  flushRight = false,
}: {
  onNavigate: () => void;
  t: (key: MessageKey) => string;
  locale: Locale;
  items: NavItem[];
  collapsed?: boolean;
  /** Desktop rail only: drop right padding so the gap to the content panel
      equals the panel's outer margin. Collapsed rail stays symmetric to keep
      icons centered. */
  flushRight?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", collapsed || flushRight ? "pl-3 pr-0" : "px-3")}>
      {items.map((item) => (
        <NavItemLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} t={t} locale={locale} />
      ))}
    </div>
  );
}

function NavItemLink({
  item,
  collapsed = false,
  onNavigate,
  t,
  locale,
}: {
  item: NavItem;
  collapsed?: boolean;
  onNavigate: () => void;
  t: (key: MessageKey) => string;
  locale: Locale;
}) {
  const label = item.labelKey ? t(item.labelKey) : item.label?.[locale] || item.to;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? label : undefined}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/55 hover:text-foreground",
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
}

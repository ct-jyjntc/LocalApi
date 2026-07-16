import { NavLink, Outlet } from "react-router-dom";
import {
  Activity,
  ChartNoAxesCombined,
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
import { api, userApi } from "@/lib/api";
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
  { to: "/settings", labelKey: "nav.settings", icon: Settings },
];

const USER_NAV: NavItem[] = [
  { to: "/", label: { zh: "概览", en: "Overview" }, icon: LayoutDashboard, end: true },
  { to: "/keys", labelKey: "nav.keys", icon: KeyRound },
  { to: "/usage", label: { zh: "用量与账单", en: "Usage" }, icon: ChartNoAxesCombined },
  { to: "/logs", labelKey: "nav.logs", icon: ScrollText },
];

const COLLAPSE_KEY = "localapi_sidebar_collapsed";

export function AppShell({ mode = "admin", onLogout }: { mode?: "admin" | "user"; onLogout?: () => void }) {
  const { t, locale } = useI18n();
  const nav = mode === "admin" ? ADMIN_NAV : USER_NAV;
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        if (mode === "admin") await api.health();
        else await userApi.me();
        if (alive) setOnline(true);
      } catch {
        if (alive) setOnline(false);
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mode]);

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

  const statusLabel =
    online === true
      ? t("shell.online")
      : online === false
        ? t("shell.offline")
        : t("shell.checking");

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside
        className="fixed inset-y-0 left-0 z-30 hidden h-screen flex-col bg-sidebar py-6 transition-[width] duration-200 ease-out lg:flex"
        style={{ width }}
      >
        <SidebarChrome
          brand={t("shell.brand")}
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
          online={online}
          statusLabel={statusLabel}
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
          <aside className="absolute inset-y-0 left-0 flex w-[240px] flex-col bg-sidebar py-6 shadow-lg">
            <div className="flex h-8 shrink-0 items-center gap-1 px-3">
              <span className="min-w-0 flex-1 truncate px-0.5 text-sm font-semibold">
                {t("shell.brand")}
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
              online={online}
              statusLabel={statusLabel}
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
          <span className="text-sm font-semibold">{t("shell.brand")}</span>
          <span
            className={cn(
              "ml-auto size-1.5 rounded-full",
              online === true
                ? "bg-success"
                : online === false
                  ? "bg-destructive"
                  : "bg-muted-foreground/50",
            )}
            title={statusLabel}
          />
        </header>

        <main className="mx-auto w-full max-w-[1280px] flex-1 px-5 py-8 pb-6 sm:px-8">
          <Outlet />
        </main>
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
  online,
  statusLabel,
  onLogout,
  logoutLabel,
}: {
  collapsed: boolean;
  online: boolean | null;
  statusLabel: string;
  onLogout?: () => void;
  logoutLabel: string;
}) {
  return (
    <div className="mt-4 shrink-0 px-2">
      <div
        className={cn(
          "flex items-center gap-2 rounded-md bg-secondary/55 px-2.5 py-2 text-[11px] text-muted-foreground",
          collapsed && "justify-center px-0",
        )}
        title={statusLabel}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            online === true
              ? "bg-success"
              : online === false
                ? "bg-destructive"
                : "bg-muted-foreground/50",
          )}
        />
        {!collapsed ? (
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <Activity className="size-3 shrink-0" strokeWidth={1.8} />
            <span className="truncate">{statusLabel}</span>
          </span>
        ) : null}
        {onLogout ? (
          <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onLogout} title={logoutLabel} aria-label={logoutLabel}>
            <LogOut />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

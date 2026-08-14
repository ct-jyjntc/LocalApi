import { lazy, useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/features/LoginPage";
import { OAuthAuthorizePage } from "@/features/OAuthAuthorizePage";
import { I18nProvider } from "@/lib/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import {
  api,
  AUTH_EXPIRED_EVENT,
  clearAdminToken,
  clearUserToken,
  getAdminToken,
  getAdminEntryPath,
  getUserToken,
  setAdminEntryPath,
  userApi,
  type AuthExpiredDetail,
} from "@/lib/api";

const DashboardPage = lazy(() =>
  import("@/features/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const KeysPage = lazy(() =>
  import("@/features/KeysPage").then((m) => ({ default: m.KeysPage })),
);
const LogsPage = lazy(() =>
  import("@/features/LogsPage").then((m) => ({ default: m.LogsPage })),
);
const ProvidersPage = lazy(() =>
  import("@/features/ProvidersPage").then((m) => ({ default: m.ProvidersPage })),
);
const ProxiesPage = lazy(() =>
  import("@/features/ProxiesPage").then((m) => ({ default: m.ProxiesPage })),
);
const SettingsPage = lazy(() =>
  import("@/features/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const UsersPage = lazy(() =>
  import("@/features/UsersPage").then((m) => ({ default: m.UsersPage })),
);
const PricingPage = lazy(() =>
  import("@/features/PricingPage").then((m) => ({ default: m.PricingPage })),
);
const PlansPage = lazy(() =>
  import("@/features/PlansPage").then((m) => ({ default: m.PlansPage })),
);
const UserDashboardPage = lazy(() =>
  import("@/features/UserDashboardPage").then((m) => ({ default: m.UserDashboardPage })),
);
const UserModelsPage = lazy(() =>
  import("@/features/UserModelsPage").then((m) => ({ default: m.UserModelsPage })),
);
const UserFeedbackPage = lazy(() =>
  import("@/features/UserFeedbackPage").then((m) => ({ default: m.UserFeedbackPage })),
);
const FeedbackPage = lazy(() =>
  import("@/features/FeedbackPage").then((m) => ({ default: m.FeedbackPage })),
);
const UserKeysPage = lazy(() =>
  import("@/features/UserKeysPage").then((m) => ({ default: m.UserKeysPage })),
);
const UserUsagePage = lazy(() =>
  import("@/features/UserUsagePage").then((m) => ({ default: m.UserUsagePage })),
);
const CommercialUsagePage = lazy(() =>
  import("@/features/CommercialUsagePage").then((m) => ({ default: m.CommercialUsagePage })),
);
const UserPlanPage = lazy(() =>
  import("@/features/UserPlanPage").then((m) => ({ default: m.UserPlanPage })),
);
const PaymentsPage = lazy(() =>
  import("@/features/PaymentsPage").then((m) => ({ default: m.PaymentsPage })),
);
const UserPaymentsPage = lazy(() =>
  import("@/features/UserPaymentsPage").then((m) => ({ default: m.UserPaymentsPage })),
);
const TiersPage = lazy(() =>
  import("@/features/TiersPage").then((m) => ({ default: m.TiersPage })),
);
const UserSettingsPage = lazy(() =>
  import("@/features/UserSettingsPage").then((m) => ({ default: m.UserSettingsPage })),
);
const UserCheckinPage = lazy(() =>
  import("@/features/UserCheckinPage").then((m) => ({ default: m.UserCheckinPage })),
);
const ModulesPage = lazy(() =>
  import("@/features/ModulesPage").then((m) => ({ default: m.ModulesPage })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // M13: never auto-retry 401s — the session is already dead and the
      // request() helper has already cleared the token + fired AUTH_EXPIRED.
      retry: (failureCount, error) => {
        if (error instanceof Error && "status" in error && (error as { status: number }).status === 401) {
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

function ClearLegacyUiScale() {
  useEffect(() => {
    document.documentElement.style.removeProperty("font-size");
    localStorage.removeItem("localapi_ui_scale");
  }, []);
  return null;
}

type AuthMode = "admin" | "user";

function AuthedApp({ mode, onLogout }: { mode: AuthMode; onLogout: () => void }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell mode={mode} onLogout={onLogout} />}>
          {mode === "admin" ? (
            <>
              <Route index element={<DashboardPage />} />
              <Route path="providers" element={<ProvidersPage />} />
              <Route path="proxies" element={<ProxiesPage />} />
              <Route path="keys" element={<KeysPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="pricing" element={<PricingPage />} />
              <Route path="plans" element={<PlansPage />} />
              <Route path="tiers" element={<TiersPage />} />
              <Route path="billing" element={<CommercialUsagePage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="modules" element={<ModulesPage />} />
              <Route path="logs" element={<LogsPage />} />
              <Route path="feedback" element={<FeedbackPage />} />
              <Route path="settings" element={<SettingsPage onLogout={onLogout} />} />
            </>
          ) : (
            <>
              <Route index element={<UserDashboardPage />} />
              <Route path="models" element={<UserModelsPage />} />
              <Route path="keys" element={<UserKeysPage />} />
              <Route path="plan" element={<UserPlanPage />} />
              <Route path="usage" element={<UserUsagePage />} />
              <Route path="payments" element={<UserPaymentsPage />} />
              <Route path="checkin" element={<UserCheckinPage />} />
              <Route path="feedback" element={<UserFeedbackPage />} />
              <Route path="settings" element={<UserSettingsPage />} />
            </>
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function Root() {
  const [mode, setMode] = useState<AuthMode | null | "loading">("loading");
  const [loginMode, setLoginMode] = useState<AuthMode>("user");
  const [adminEntryPath, setAdminEntryPathState] = useState(getAdminEntryPath());

  const verify = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const linuxdoCode = params.get("linuxdo_code");
    if (linuxdoCode) {
      // One-time login code from the OAuth callback. Exchange it for a session
      // token over POST — the full-access token never travels in the URL, and
      // the exchange is bound to the nonce cookie set when the login started,
      // so a code delivered out-of-band cannot log this browser into someone
      // else's account.
      try {
        const exchanged = await userApi.linuxdoExchange(linuxdoCode);
        localStorage.setItem("localapi_user_token", exchanged.token);
        localStorage.setItem("localapi_auth_mode", "user");
      } catch {
        // Exchange failed (expired/mismatched code): fall through to normal
        // verification so the login page is shown.
      }
      window.history.replaceState(null, "", window.location.pathname);
    }
    const preferred = localStorage.getItem("localapi_auth_mode") as AuthMode | null;
    const attempts: AuthMode[] = preferred === "user" ? ["user", "admin"] : ["admin", "user"];
    for (const candidate of attempts) {
      try {
        if (candidate === "admin" && getAdminToken()) {
          await api.health();
          setMode("admin");
          return;
        }
        if (candidate === "user" && getUserToken()) {
          await userApi.me();
          setMode("user");
          return;
        }
      } catch {
        if (candidate === "admin") clearAdminToken();
        else clearUserToken();
      }
    }
    const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
    if (currentPath !== "/") {
      try {
        await api.adminEntry(currentPath);
        setAdminEntryPath(currentPath);
        setAdminEntryPathState(currentPath);
        setLoginMode("admin");
        setMode(null);
        return;
      } catch {
        window.history.replaceState(null, "", "/");
      }
    }
    setLoginMode("user");
    setMode(null);
  }, []);

  useEffect(() => {
    verify();
  }, [verify]);

  // M13: mid-session 401s (expired/revoked tokens) are emitted by request().
  // Drop the matching mode, wipe the react-query cache (M14), and bounce the
  // UI back to the login page so the user never sits on a stuck dashboard.
  useEffect(() => {
    const onExpired = (event: Event) => {
      const detail = (event as CustomEvent<AuthExpiredDetail>).detail;
      const expiredMode = detail?.mode;
      queryClient.clear();
      if (expiredMode === "admin") {
        clearAdminToken();
        const entryPath = getAdminEntryPath();
        window.history.replaceState(null, "", entryPath);
        setAdminEntryPathState(entryPath);
        setLoginMode("admin");
      } else {
        clearUserToken();
        window.history.replaceState(null, "", "/");
        setLoginMode("user");
      }
      setMode(null);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  if (mode === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-xs text-muted-foreground">
        …
      </div>
    );
  }

  if (!mode) {
    return <LoginPage mode={loginMode} adminEntryPath={adminEntryPath} onSuccess={(nextMode) => setMode(nextMode)} />;
  }

  return (
    <AuthedApp
      mode={mode}
      onLogout={() => {
        // M14: wipe the react-query cache on logout so the next account never
        // briefly renders the previous user's wallet / plan / keys.
        queryClient.clear();
        if (mode === "admin") {
          const entryPath = getAdminEntryPath();
          clearAdminToken();
          window.history.replaceState(null, "", entryPath);
          setAdminEntryPathState(entryPath);
          setLoginMode("admin");
        } else {
          userApi.logout().catch(() => undefined);
          clearUserToken();
          window.history.replaceState(null, "", "/");
          setLoginMode("user");
        }
        setMode(null);
      }}
    />
  );
}

export default function App() {
  // The OAuth consent page lives outside <Root />: Root's verify() rewrites
  // the URL and would drop the `state` parameter mid-authorization.
  if (window.location.pathname.startsWith("/oauth/authorize")) {
    return (
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <I18nProvider>
          <QueryClientProvider client={queryClient}>
            <OAuthAuthorizePage />
          </QueryClientProvider>
        </I18nProvider>

      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <AppDialogProvider>
            <ClearLegacyUiScale />
            <Root />
          </AppDialogProvider>
          <Toaster
            position="top-right"
            richColors
            closeButton
            toastOptions={{ className: "text-xs" }}
          />
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

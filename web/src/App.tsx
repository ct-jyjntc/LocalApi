import { useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { AppShell } from "@/components/AppShell";
import { DashboardPage } from "@/features/DashboardPage";
import { KeysPage } from "@/features/KeysPage";
import { LoginPage } from "@/features/LoginPage";
import { LogsPage } from "@/features/LogsPage";
import { ProvidersPage } from "@/features/ProvidersPage";
import { SettingsPage } from "@/features/SettingsPage";
import { UsersPage } from "@/features/UsersPage";
import { PricingPage } from "@/features/PricingPage";
import { PlansPage } from "@/features/PlansPage";
import { UserDashboardPage } from "@/features/UserDashboardPage";
import { UserModelsPage } from "@/features/UserModelsPage";
import { UserKeysPage } from "@/features/UserKeysPage";
import { UserUsagePage } from "@/features/UserUsagePage";
import { CommercialUsagePage } from "@/features/CommercialUsagePage";
import { UserPlanPage } from "@/features/UserPlanPage";
import { PaymentsPage } from "@/features/PaymentsPage";
import { UserPaymentsPage } from "@/features/UserPaymentsPage";
import { TiersPage } from "@/features/TiersPage";
import { UserSettingsPage } from "@/features/UserSettingsPage";
import { I18nProvider } from "@/lib/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import {
  api,
  clearAdminToken,
  clearUserToken,
  getAdminToken,
  getAdminEntryPath,
  getUserToken,
  setAdminEntryPath,
  userApi,
} from "@/lib/api";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
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
              <Route path="keys" element={<KeysPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="pricing" element={<PricingPage />} />
              <Route path="plans" element={<PlansPage />} />
              <Route path="tiers" element={<TiersPage />} />
              <Route path="billing" element={<CommercialUsagePage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="logs" element={<LogsPage />} />
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
    const linuxdoToken = params.get("linuxdo_token");
    if (linuxdoToken) {
      localStorage.setItem("localapi_user_token", linuxdoToken);
      localStorage.setItem("localapi_auth_mode", "user");
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

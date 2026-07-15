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
import { I18nProvider } from "@/lib/i18n";
import { api, clearAdminToken, getAdminToken } from "@/lib/api";

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

function AuthedApp({ onLogout }: { onLogout: () => void }) {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route
            path="settings"
            element={<SettingsPage onLogout={onLogout} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function Root() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  const verify = useCallback(async () => {
    const token = getAdminToken();
    if (!token) {
      setAuthed(false);
      return;
    }
    try {
      await api.health();
      setAuthed(true);
    } catch {
      clearAdminToken();
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    verify();
  }, [verify]);

  if (authed === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-xs text-muted-foreground">
        …
      </div>
    );
  }

  if (!authed) {
    return <LoginPage onSuccess={() => setAuthed(true)} />;
  }

  return (
    <AuthedApp
      onLogout={() => {
        clearAdminToken();
        setAuthed(false);
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
          <ClearLegacyUiScale />
          <Root />
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

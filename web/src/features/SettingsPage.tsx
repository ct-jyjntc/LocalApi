import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  api,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
} from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useI18n, type Locale } from "@/lib/i18n";

export function SettingsPage({ onLogout }: { onLogout?: () => void }) {
  const { theme, setTheme } = useTheme();
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.get(),
  });

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [maxRetries, setMaxRetries] = useState(2);
  const [retryDelayMs, setRetryDelayMs] = useState(400);
  const [brandName, setBrandName] = useState("LocalAPI");
  const [companyName, setCompanyName] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  useEffect(() => {
    document.documentElement.style.removeProperty("font-size");
    localStorage.removeItem("localapi_ui_scale");
  }, []);

  useEffect(() => {
    if (!data) return;
    setMaxRetries(Number(data.max_retries ?? 2));
    setRetryDelayMs(Number(data.retry_delay_ms ?? 400));
    setBrandName(data.brand_name || "LocalAPI");
    setCompanyName(data.company_name || "");
    setRegistrationEnabled(Boolean(data.registration_enabled));
  }, [data]);

  const savePassword = useMutation({
    mutationFn: async () => {
      if (!newPassword.trim()) {
        throw new Error(t("settings.passwordRequired"));
      }
      if (newPassword.trim().length < 8) {
        throw new Error(t("settings.passwordTooShort"));
      }
      if (newPassword !== confirmPassword) {
        throw new Error(t("settings.passwordMismatch"));
      }
      return api.settings.update({
        admin_password: newPassword.trim(),
        current_admin_password:
          currentPassword.trim() || getAdminToken() || undefined,
      });
    },
    onSuccess: () => {
      const next = newPassword.trim();
      setAdminToken(next);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success(t("settings.passwordSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveRelay = useMutation({
    mutationFn: async () =>
      api.settings.update({
        max_retries: Math.max(0, Math.floor(Number(maxRetries) || 0)),
        retry_delay_ms: Math.max(0, Math.min(10_000, Number(retryDelayMs) || 0)),
      }),
    onSuccess: () => {
      toast.success(t("settings.relaySaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveBranding = useMutation({
    mutationFn: async () => api.settings.update({
      brand_name: brandName.trim() || "LocalAPI",
      company_name: companyName.trim(),
    }),
    onSuccess: () => {
      toast.success(t("settings.brandingSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["branding"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveRegistration = useMutation({
    mutationFn: async () => api.settings.update({ registration_enabled: registrationEnabled }),
    onSuccess: () => {
      toast.success(t("settings.registrationSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["user-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const themes = [
    { id: "light" as const, label: t("settings.theme.light") },
    { id: "dark" as const, label: t("settings.theme.dark") },
    { id: "system" as const, label: t("settings.theme.system") },
  ];

  const locales: Array<{ id: Locale; label: string }> = [
    { id: "zh", label: t("settings.language.zh") },
    { id: "en", label: t("settings.language.en") },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("settings.title")}
        description={t("settings.desc")}
        actions={
          onLogout ? (
            <Button
              variant="secondary"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                clearAdminToken();
                onLogout();
              }}
            >
              {t("login.logout")}
            </Button>
          ) : null
        }
      />

      <Card className="space-y-4 p-4 sm:p-5">
        <h2 className="text-sm font-medium">{t("settings.appearance")}</h2>
        <div className="space-y-1.5">
          <Label>{t("settings.theme")}</Label>
          <Segmented
            options={themes}
            value={theme ?? "system"}
            onChange={(v) => setTheme(v)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("settings.language")}</Label>
          <Segmented
            options={locales}
            value={locale}
            onChange={(v) => setLocale(v)}
          />
        </div>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-medium">{t("settings.registration")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.registrationHint")}</p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2.5">
          <div>
            <p className="text-xs font-medium">{t("settings.registrationOpen")}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{registrationEnabled ? t("settings.registrationOpenHint") : t("settings.registrationClosedHint")}</p>
          </div>
          <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saveRegistration.isPending} onClick={() => saveRegistration.mutate()}>
            {saveRegistration.isPending ? t("common.loading") : t("settings.saveRegistration")}
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-medium">{t("settings.branding")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.brandingHint")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("settings.brandName")}</Label>
            <Input value={brandName} maxLength={80} onChange={(event) => setBrandName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.companyName")}</Label>
            <Input value={companyName} maxLength={160} onChange={(event) => setCompanyName(event.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("settings.companyHint")}</p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saveBranding.isPending || !brandName.trim()} onClick={() => saveBranding.mutate()}>
            {saveBranding.isPending ? t("common.loading") : t("settings.saveBranding")}
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-medium">{t("settings.relay")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("settings.relayHint")}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("settings.maxRetries")}</Label>
            <Input
              type="number"
              min={0}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.target.value))}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("settings.maxRetriesHint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.retryDelay")}</Label>
            <Input
              type="number"
              min={0}
              max={10000}
              step={50}
              value={retryDelayMs}
              onChange={(e) => setRetryDelayMs(Number(e.target.value))}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("settings.retryDelayHint")}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={saveRelay.isPending}
            onClick={() => saveRelay.mutate()}
          >
            {saveRelay.isPending ? t("common.loading") : t("settings.saveRelay")}
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-medium">{t("settings.admin")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("settings.adminHint", {
              hint: data?.admin_password_hint || "••••",
            })}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>{t("settings.currentPassword")}</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder={t("settings.currentPasswordPh")}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.newPassword")}</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t("settings.newPasswordPh")}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.confirmPassword")}</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t("settings.confirmPasswordPh")}
              autoComplete="new-password"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={savePassword.isPending || !newPassword}
            onClick={() => savePassword.mutate()}
          >
            {savePassword.isPending
              ? t("common.loading")
              : t("settings.changePassword")}
          </Button>
        </div>
      </Card>

      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-medium">{t("settings.usage")}</h2>
        <p className="text-xs text-muted-foreground">{t("settings.usageHint")}</p>
        <pre className="overflow-x-auto rounded-md bg-secondary/55 p-3 font-mono text-[11px] leading-5">
{`# 非流式
curl http://127.0.0.1:5555/v1/chat/completions \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":false}'

# 流式 SSE
curl -N http://127.0.0.1:5555/v1/chat/completions \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":true}'`}
        </pre>
      </Card>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ id: T; label: string }>;
  value: string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex h-8 w-fit items-center gap-0.5 rounded-md bg-muted p-0.5">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={cn(
            "inline-flex h-7 items-center justify-center rounded-[5px] px-3 text-xs font-medium text-muted-foreground transition-[color,background-color,box-shadow] hover:text-foreground",
            value === opt.id && "bg-background text-foreground shadow-sm",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

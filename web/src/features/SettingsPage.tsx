import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  api,
  clearAdminToken,
  getAdminToken,
  setAdminEntryPath,
  setAdminToken,
} from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useI18n, type Locale } from "@/lib/i18n";
import { hasModuleFeature, usePublicModules } from "@/lib/modules";
import { applyDocumentTitle, BRANDING_QUERY_KEY, DEFAULT_BRAND_NAME, formatBrandTitle, persistBranding, resolveBrandName } from "@/lib/branding";

export function SettingsPage({ onLogout }: { onLogout?: () => void }) {
  const { theme, setTheme } = useTheme();
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const iconFileRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.get(),
  });
  const publicModules = usePublicModules();
  const linuxdoModuleActive = hasModuleFeature(publicModules.data?.items, "auth.linuxdo");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [maxRetries, setMaxRetries] = useState(2);
  const [otherMaxRetries, setOtherMaxRetries] = useState(0);
  const [retryDelayMs, setRetryDelayMs] = useState(400);
  const [brandName, setBrandName] = useState(() => resolveBrandName());
  const [brandTagline, setBrandTagline] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [proxyTestUrl, setProxyTestUrl] = useState("");
  const [announcementEnabled, setAnnouncementEnabled] = useState(false);
  const [announcementTitle, setAnnouncementTitle] = useState("");
  const [announcementContent, setAnnouncementContent] = useState("");
  const [announcementBanner, setAnnouncementBanner] = useState(true);
  const [announcementPopup, setAnnouncementPopup] = useState(true);
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [adminEntryPath, setAdminEntryPathState] = useState("/admin");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState(true);
  const [linuxdoRegistrationEnabled, setLinuxdoRegistrationEnabled] = useState(true);
  const [checkinEnabled, setCheckinEnabled] = useState(true);
  const [checkinPointsMin, setCheckinPointsMin] = useState("1.00");
  const [checkinPointsMax, setCheckinPointsMax] = useState("10.00");
  const [pointsBalanceCap, setPointsBalanceCap] = useState("0");
  const [pointsExchangeRate, setPointsExchangeRate] = useState("0.01");
  const [linuxdoEnabled, setLinuxdoEnabled] = useState(false);
  const [linuxdoClientId, setLinuxdoClientId] = useState("");
  const [linuxdoClientSecret, setLinuxdoClientSecret] = useState("");
  const [linuxdoRelayUrl, setLinuxdoRelayUrl] = useState("");
  const [linuxdoRelaySecret, setLinuxdoRelaySecret] = useState("");

  useEffect(() => {
    document.documentElement.style.removeProperty("font-size");
    localStorage.removeItem("localapi_ui_scale");
  }, []);

  useEffect(() => {
    if (!data) return;
    setMaxRetries(Number(data.max_retries ?? 2));
    setOtherMaxRetries(Number(data.other_max_retries ?? 0));
    setRetryDelayMs(Number(data.retry_delay_ms ?? 400));
    setBrandName(data.brand_name || DEFAULT_BRAND_NAME);
    setBrandTagline(data.brand_tagline || "");
    setCompanyName(data.company_name || "");
    setProxyTestUrl(data.proxy_test_url || "");
    setAnnouncementEnabled(Boolean(data.announcement_enabled));
    setAnnouncementTitle(data.announcement_title || "");
    setAnnouncementContent(data.announcement_content || "");
    setAnnouncementBanner(data.announcement_banner !== false);
    setAnnouncementPopup(data.announcement_popup !== false);
    setPublicBaseUrl(data.public_base_url || "");
    setAdminEntryPathState(data.admin_entry_path || "/admin");
    setRegistrationEnabled(Boolean(data.registration_enabled));
    setPasswordLoginEnabled(data.password_login_enabled !== false);
    setLinuxdoRegistrationEnabled(data.linuxdo_registration_enabled !== false);
    setCheckinEnabled(data.checkin_enabled !== false);
    setCheckinPointsMin(Number(data.checkin_points_min ?? 1).toFixed(2));
    setCheckinPointsMax(Number(data.checkin_points_max ?? 10).toFixed(2));
    setPointsBalanceCap(Number(data.points_balance_cap ?? 0).toFixed(2));
    setPointsExchangeRate(String(data.points_exchange_rate ?? 0.01));
    setLinuxdoEnabled(Boolean(data.linuxdo_login_enabled));
    setLinuxdoClientId(data.linuxdo_client_id || "");
    setLinuxdoClientSecret("");
    setLinuxdoRelayUrl(data.linuxdo_relay_url || "");
    setLinuxdoRelaySecret("");
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

  const saveProxyHealth = useMutation({
    mutationFn: async () =>
      api.settings.update({
        proxy_test_url: proxyTestUrl.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success(t("settings.proxyTestUrlSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveRelay = useMutation({
    mutationFn: async () =>
      api.settings.update({
        max_retries: Math.max(0, Math.min(100, Math.floor(Number(maxRetries) || 0))),
        other_max_retries: Math.max(0, Math.min(100, Math.floor(Number(otherMaxRetries) || 0))),
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
      brand_name: brandName.trim() || DEFAULT_BRAND_NAME,
      brand_tagline: brandTagline.trim(),
      company_name: companyName.trim(),
      public_base_url: publicBaseUrl.trim(),
    }),
    onSuccess: (result) => {
      persistBranding({
        brandName: result.brand_name,
        companyName: result.company_name,
        tagline: result.brand_tagline,
        iconUrl: result.brand_icon_url,
      });
      applyDocumentTitle(formatBrandTitle(result.brand_name || DEFAULT_BRAND_NAME, result.brand_tagline));
      toast.success(t("settings.brandingSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: BRANDING_QUERY_KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyIconResult = (result: { brand_name: string; company_name?: string; brand_tagline?: string; brand_icon_url?: string | null }) => {
    persistBranding({
      brandName: result.brand_name,
      companyName: result.company_name,
      tagline: result.brand_tagline,
      iconUrl: result.brand_icon_url,
    });
    qc.invalidateQueries({ queryKey: ["settings"] });
    qc.invalidateQueries({ queryKey: BRANDING_QUERY_KEY });
  };

  const uploadBrandIcon = useMutation({
    mutationFn: (file: File) => api.settings.uploadBrandIcon(file),
    onSuccess: (result) => {
      applyIconResult(result);
      toast.success(locale === "zh" ? "品牌图标已更新" : "Brand icon updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeBrandIcon = useMutation({
    mutationFn: () => api.settings.removeBrandIcon(),
    onSuccess: (result) => {
      applyIconResult(result);
      toast.success(locale === "zh" ? "品牌图标已移除" : "Brand icon removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveAnnouncement = useMutation({
    mutationFn: async () =>
      api.settings.update({
        announcement_enabled: announcementEnabled,
        announcement_title: announcementTitle.trim(),
        announcement_content: announcementContent.trim(),
        announcement_banner: announcementBanner,
        announcement_popup: announcementPopup,
      }),
    onSuccess: () => {
      toast.success(locale === "zh" ? "公告已保存" : "Announcement saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["branding"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveRegistration = useMutation({
    mutationFn: async () =>
      api.settings.update({
        registration_enabled: registrationEnabled,
        linuxdo_registration_enabled: linuxdoRegistrationEnabled,
      }),
    onSuccess: () => {
      toast.success(t("settings.registrationSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["user-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveLoginMethods = useMutation({
    mutationFn: async () =>
      api.settings.update({
        password_login_enabled: passwordLoginEnabled,
        linuxdo_login_enabled: linuxdoEnabled,
      }),
    onSuccess: () => {
      toast.success(t("settings.loginMethodsSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["user-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveCheckin = useMutation({
    mutationFn: async () =>
      api.settings.update({
        checkin_enabled: checkinEnabled,
        checkin_points_min: Math.max(0, Number(checkinPointsMin) || 0),
        checkin_points_max: Math.max(0, Number(checkinPointsMax) || 0),
        points_balance_cap: Math.max(0, Number(pointsBalanceCap) || 0),
        points_exchange_rate: Math.max(0, Number(pointsExchangeRate) || 0),
      }),
    onSuccess: () => {
      toast.success(t("settings.checkinSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["user", "checkin"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveLinuxDo = useMutation({
    mutationFn: async () => {
      const body: Parameters<typeof api.settings.update>[0] = {
        linuxdo_login_enabled: linuxdoEnabled,
        linuxdo_client_id: linuxdoClientId.trim(),
        linuxdo_relay_url: linuxdoRelayUrl.trim(),
      };
      if (linuxdoClientSecret.trim()) {
        body.linuxdo_client_secret = linuxdoClientSecret.trim();
      }
      if (linuxdoRelaySecret.trim()) {
        body.linuxdo_relay_secret = linuxdoRelaySecret.trim();
      } else if (!linuxdoRelayUrl.trim() && data?.linuxdo_relay_secret_set) {
        // Clear relay secret when relay URL is removed.
        body.linuxdo_relay_secret = "";
      }
      return api.settings.update(body);
    },
    onSuccess: () => {
      setLinuxdoClientSecret("");
      setLinuxdoRelaySecret("");
      toast.success(t("settings.linuxdoSaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["user-config"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveAdminEntry = useMutation({
    mutationFn: async () => api.settings.update({ admin_entry_path: adminEntryPath.trim() }),
    onSuccess: (result) => {
      const nextPath = result.admin_entry_path || "/admin";
      setAdminEntryPathState(nextPath);
      setAdminEntryPath(nextPath);
      toast.success(t("settings.adminEntrySaved"));
      qc.invalidateQueries({ queryKey: ["settings"] });
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
  const exampleBaseUrl = data?.public_base_url?.trim() || "https://your-domain";
  const adminEntryPreview = `${data?.public_base_url?.trim() || window.location.origin}${adminEntryPath.startsWith("/") ? adminEntryPath : `/${adminEntryPath}`}`;

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
          <h2 className="text-sm font-medium">{t("settings.loginMethods")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.loginMethodsHint")}</p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2.5">
          <div>
            <p className="text-xs font-medium">{t("settings.loginPassword")}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {passwordLoginEnabled ? t("settings.loginPasswordOn") : t("settings.loginPasswordOff")}
            </p>
          </div>
          <Switch checked={passwordLoginEnabled} onCheckedChange={setPasswordLoginEnabled} />
        </div>
        {linuxdoModuleActive ? (
          <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2.5">
            <div>
              <p className="text-xs font-medium">{t("settings.loginLinuxdo")}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {linuxdoEnabled
                  ? data?.linuxdo_authorize_ready
                    ? t("settings.loginLinuxdoOn")
                    : t("settings.linuxdoIncompleteHint")
                  : t("settings.loginLinuxdoOff")}
              </p>
              {!data?.linuxdo_authorize_ready ? (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{t("settings.registrationLinuxdoNeedConfig")}</p>
              ) : null}
            </div>
            <Switch checked={linuxdoEnabled} onCheckedChange={setLinuxdoEnabled} />
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button size="sm" disabled={saveLoginMethods.isPending} onClick={() => saveLoginMethods.mutate()}>
            {saveLoginMethods.isPending ? t("common.loading") : t("settings.saveLoginMethods")}
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-medium">{t("settings.registration")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.registrationHint")}</p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2.5">
          <div>
            <p className="text-xs font-medium">{t("settings.registrationPassword")}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {registrationEnabled ? t("settings.registrationPasswordOn") : t("settings.registrationPasswordOff")}
            </p>
          </div>
          <Switch checked={registrationEnabled} onCheckedChange={setRegistrationEnabled} />
        </div>
        {linuxdoModuleActive ? (
          <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2.5">
            <div>
              <p className="text-xs font-medium">{t("settings.registrationLinuxdo")}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {linuxdoRegistrationEnabled ? t("settings.registrationLinuxdoOn") : t("settings.registrationLinuxdoOff")}
              </p>
              {!data?.linuxdo_authorize_ready ? (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{t("settings.registrationLinuxdoNeedConfig")}</p>
              ) : null}
            </div>
            <Switch checked={linuxdoRegistrationEnabled} onCheckedChange={setLinuxdoRegistrationEnabled} />
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button size="sm" disabled={saveRegistration.isPending} onClick={() => saveRegistration.mutate()}>
            {saveRegistration.isPending ? t("common.loading") : t("settings.saveRegistration")}
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-medium">{t("settings.checkin")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.checkinHint")}</p>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2.5">
          <div>
            <p className="text-xs font-medium">{t("settings.checkinEnable")}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {checkinEnabled ? t("settings.checkinEnabledHint") : t("settings.checkinDisabledHint")}
            </p>
          </div>
          <Switch checked={checkinEnabled} onCheckedChange={setCheckinEnabled} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("settings.checkinPointsMin")}</Label>
            <Input
              type="number"
              min={0}
              max={1000000}
              step="0.01"
              value={checkinPointsMin}
              onChange={(event) => setCheckinPointsMin(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.checkinPointsMax")}</Label>
            <Input
              type="number"
              min={0}
              max={1000000}
              step="0.01"
              value={checkinPointsMax}
              onChange={(event) => setCheckinPointsMax(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.pointsBalanceCap")}</Label>
            <Input
              type="number"
              min={0}
              max={1000000000}
              step="0.01"
              value={pointsBalanceCap}
              onChange={(event) => setPointsBalanceCap(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{t("settings.pointsBalanceCapHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.pointsExchangeRate")}</Label>
            <Input
              type="number"
              min={0}
              step="0.000001"
              value={pointsExchangeRate}
              onChange={(event) => setPointsExchangeRate(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{t("settings.pointsExchangeRateHint")}</p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saveCheckin.isPending} onClick={() => saveCheckin.mutate()}>
            {saveCheckin.isPending ? t("common.loading") : t("settings.saveCheckin")}
          </Button>
        </div>
      </Card>

      {linuxdoModuleActive ? (
        <Card className="space-y-4 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-medium">{t("settings.linuxdo")}</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.linuxdoHint")}</p>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/55 px-3 py-2.5">
            <div>
              <p className="text-xs font-medium">{t("settings.linuxdoEnable")}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {linuxdoEnabled
                  ? data?.linuxdo_authorize_ready
                    ? t("settings.linuxdoReadyHint")
                    : t("settings.linuxdoIncompleteHint")
                  : t("settings.linuxdoDisabledHint")}
              </p>
            </div>
            <Switch checked={linuxdoEnabled} onCheckedChange={setLinuxdoEnabled} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("settings.linuxdoClientId")}</Label>
              <Input
                className="font-mono text-xs"
                value={linuxdoClientId}
                maxLength={256}
                spellCheck={false}
                placeholder="LinuxDo OAuth Client ID"
                onChange={(event) => setLinuxdoClientId(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings.linuxdoClientSecret")}</Label>
              <Input
                className="font-mono text-xs"
                type="password"
                value={linuxdoClientSecret}
                maxLength={4096}
                spellCheck={false}
                placeholder={
                  data?.linuxdo_client_secret_set
                    ? t("settings.secretKeepPlaceholder")
                    : t("settings.linuxdoClientSecretPh")
                }
                onChange={(event) => setLinuxdoClientSecret(event.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">{t("settings.linuxdoClientSecretHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings.linuxdoRelayUrl")}</Label>
              <Input
                className="font-mono text-xs"
                value={linuxdoRelayUrl}
                maxLength={512}
                spellCheck={false}
                placeholder="https://relay.example.com"
                onChange={(event) => setLinuxdoRelayUrl(event.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">{t("settings.linuxdoRelayUrlHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings.linuxdoRelaySecret")}</Label>
              <Input
                className="font-mono text-xs"
                type="password"
                value={linuxdoRelaySecret}
                maxLength={4096}
                spellCheck={false}
                placeholder={
                  data?.linuxdo_relay_secret_set
                    ? t("settings.secretKeepPlaceholder")
                    : t("settings.linuxdoRelaySecretPh")
                }
                onChange={(event) => setLinuxdoRelaySecret(event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t("settings.linuxdoCallback")}</Label>
              <Input
                className="font-mono text-xs"
                value={data?.linuxdo_callback_url || t("settings.linuxdoCallbackMissing")}
                readOnly
              />
              <p className="text-[11px] text-muted-foreground">{t("settings.linuxdoCallbackHint")}</p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" disabled={saveLinuxDo.isPending} onClick={() => saveLinuxDo.mutate()}>
              {saveLinuxDo.isPending ? t("common.loading") : t("settings.saveLinuxdo")}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">{locale === "zh" ? "站点公告" : "Announcement"}</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {locale === "zh"
                ? "开启后顶部显示公告（内容超出宽度才滚动）。启用弹窗时，用户每次打开站点都会弹出；点「关闭」仅本次，点「今日关闭」当天不再弹。"
                : "Top bar always shows when enabled (scrolls only if content overflows). With popup on, it appears every visit; Close is this visit only, Hide today lasts until tomorrow."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{locale === "zh" ? "启用" : "Enabled"}</span>
            <Switch checked={announcementEnabled} onCheckedChange={setAnnouncementEnabled} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{locale === "zh" ? "标题" : "Title"}</Label>
            <Input
              value={announcementTitle}
              maxLength={120}
              placeholder={locale === "zh" ? "例如：维护通知" : "e.g. Maintenance notice"}
              onChange={(e) => setAnnouncementTitle(e.target.value)}
              disabled={!announcementEnabled}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{locale === "zh" ? "内容" : "Content"}</Label>
            <Textarea
              value={announcementContent}
              maxLength={4000}
              rows={5}
              placeholder={locale === "zh" ? "公告正文，支持换行" : "Announcement body"}
              onChange={(e) => setAnnouncementContent(e.target.value)}
              disabled={!announcementEnabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/45 px-3 py-2 sm:col-span-2">
            <div className="min-w-0">
              <p className="text-xs">{locale === "zh" ? "顶部显示" : "Top banner"}</p>
              <p className="text-[11px] text-muted-foreground">
                {locale === "zh"
                  ? "关闭后不显示顶部公告条（弹窗可单独开启）。"
                  : "Turn off to hide the top ticker; popup can still be enabled."}
              </p>
            </div>
            <Switch
              checked={announcementBanner}
              onCheckedChange={setAnnouncementBanner}
              disabled={!announcementEnabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md bg-secondary/45 px-3 py-2 sm:col-span-2">
            <div className="min-w-0">
              <p className="text-xs">{locale === "zh" ? "打开站点时弹出" : "Popup on open"}</p>
              <p className="text-[11px] text-muted-foreground">
                {locale === "zh"
                  ? "关闭后不弹窗；可与顶部显示独立开关。"
                  : "Turn off to disable popup; independent from the top banner."}
              </p>
            </div>
            <Switch
              checked={announcementPopup}
              onCheckedChange={setAnnouncementPopup}
              disabled={!announcementEnabled}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={saveAnnouncement.isPending || (announcementEnabled && !announcementContent.trim())}
            onClick={() => saveAnnouncement.mutate()}
          >
            {saveAnnouncement.isPending
              ? t("common.loading")
              : locale === "zh"
                ? "保存公告"
                : "Save announcement"}
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
            <p className="text-[11px] text-muted-foreground">{locale === "zh" ? "主标题，如 DeepSeek。" : "Main title, e.g. DeepSeek."}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{locale === "zh" ? "副标题" : "Tagline"}</Label>
            <Input
              value={brandTagline}
              maxLength={20}
              placeholder={locale === "zh" ? "开放平台" : "Open Platform"}
              onChange={(event) => setBrandTagline(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{locale === "zh" ? "显示在主标题旁的小标签。" : "Small badge next to the main title."}</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("settings.companyName")}</Label>
            <Input value={companyName} maxLength={160} onChange={(event) => setCompanyName(event.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("settings.companyHint")}</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{locale === "zh" ? "品牌图标" : "Brand icon"}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex size-10 items-center justify-center overflow-hidden rounded-md bg-secondary/55">
                {data?.brand_icon_url ? (
                  <img src={data.brand_icon_url} alt="" className="size-full object-contain" />
                ) : (
                  <span className="text-[11px] text-muted-foreground">—</span>
                )}
              </div>
              <input
                ref={iconFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,.ico"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  if (file.size > 512 * 1024) {
                    toast.error(locale === "zh" ? "图标需不超过 512 KB" : "Icon must be 512 KB or smaller");
                    return;
                  }
                  uploadBrandIcon.mutate(file);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="text-muted-foreground"
                disabled={uploadBrandIcon.isPending}
                onClick={() => iconFileRef.current?.click()}
              >
                {uploadBrandIcon.isPending
                  ? t("common.loading")
                  : locale === "zh" ? "上传图标" : "Upload icon"}
              </Button>
              {data?.brand_icon_url ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={removeBrandIcon.isPending}
                  onClick={() => removeBrandIcon.mutate()}
                >
                  {locale === "zh" ? "移除" : "Remove"}
                </Button>
              ) : null}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {locale === "zh"
                ? "PNG / JPEG / WebP / SVG / ICO，最大 512 KB。用于登录页、侧栏和浏览器标签图标。"
                : "PNG / JPEG / WebP / SVG / ICO, max 512 KB. Used on login, sidebar, and the tab icon."}
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("settings.publicBaseUrl")}</Label>
            <Input
              value={publicBaseUrl}
              maxLength={255}
              placeholder="your-domain"
              onChange={(event) => setPublicBaseUrl(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{t("settings.publicBaseUrlHint")}</p>
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
          <h2 className="text-sm font-medium">{t("settings.proxyTestUrl")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.proxyTestUrlHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Input
            value={proxyTestUrl}
            maxLength={255}
            placeholder="https://www.gstatic.com/generate_204"
            onChange={(event) => setProxyTestUrl(event.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saveProxyHealth.isPending} onClick={() => saveProxyHealth.mutate()}>
            {saveProxyHealth.isPending ? t("common.loading") : t("common.save")}
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
              max={100}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.target.value))}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("settings.maxRetriesHint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>{t("settings.otherMaxRetries")}</Label>
            <Input
              type="number"
              min={0}
              max={100}
              value={otherMaxRetries}
              onChange={(e) => setOtherMaxRetries(Number(e.target.value))}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("settings.otherMaxRetriesHint")}
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
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
          <h2 className="text-sm font-medium">{t("settings.adminEntry")}</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.adminEntryHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label>{t("settings.adminEntryPath")}</Label>
          <Input
            value={adminEntryPath}
            maxLength={65}
            placeholder="/admin"
            spellCheck={false}
            className="font-mono"
            onChange={(event) => setAdminEntryPathState(event.target.value)}
          />
          <p className="break-all text-[11px] text-muted-foreground">{t("settings.adminEntryPreview")} <span className="font-mono text-foreground/80">{adminEntryPreview}</span></p>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saveAdminEntry.isPending || !adminEntryPath.trim()} onClick={() => saveAdminEntry.mutate()}>
            {saveAdminEntry.isPending ? t("common.loading") : t("settings.saveAdminEntry")}
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
curl ${exampleBaseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":false}'

# 流式 SSE
curl -N ${exampleBaseUrl}/v1/chat/completions \\
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

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, setAdminToken, setUserToken, userApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { useBrand } from "@/lib/branding";
import { BrandMark } from "@/components/BrandMark";

export function LoginPage({
  mode,
  adminEntryPath,
  onSuccess,
}: {
  mode: "admin" | "user";
  adminEntryPath: string;
  onSuccess: (mode: "admin" | "user") => void;
}) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const { brandName, companyName, tagline, iconUrl } = useBrand();
  const registration = useQuery({ queryKey: ["user-config"], queryFn: userApi.config, staleTime: 30_000, enabled: mode === "user" });
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaImage, setCaptchaImage] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadCaptcha = useCallback(async () => {
    if (mode !== "user" || !isRegistering || !registration.data?.registration_enabled) return;
    setCaptchaLoading(true);
    try {
      const captcha = await userApi.captcha();
      setCaptchaId(captcha.captcha_id);
      setCaptchaImage(captcha.image);
      setCaptchaAnswer("");
    } catch {
      setCaptchaId("");
      setCaptchaImage("");
      toast.error(zh ? "验证码加载失败" : "Failed to load captcha");
    } finally {
      setCaptchaLoading(false);
    }
  }, [isRegistering, mode, registration.data?.registration_enabled, zh]);

  useEffect(() => {
    void loadCaptcha();
  }, [loadCaptcha]);

  const passwordLoginEnabled = mode !== "user" || registration.data?.password_login_enabled !== false;
  const linuxdoLoginEnabled = Boolean(registration.data?.linuxdo_enabled);
  const passwordRegistrationEnabled = Boolean(registration.data?.registration_enabled);
  const showPasswordForm = mode === "admin" || isRegistering || passwordLoginEnabled;
  const showLinuxdo = mode === "user" && linuxdoLoginEnabled && !isRegistering;
  const noUserLoginMethods =
    mode === "user" && !isRegistering && !passwordLoginEnabled && !linuxdoLoginEnabled;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (mode === "user" && !isRegistering && !passwordLoginEnabled) {
      toast.error(zh ? "当前未开放密码登录" : "Password login is disabled");
      return;
    }
    if (!password.trim()) {
      toast.error(t("login.required"));
      return;
    }
    if (mode === "user" && !username.trim()) {
      toast.error(zh ? "请输入用户名" : "Username is required");
      return;
    }
    if (mode === "user" && isRegistering && !passwordRegistrationEnabled) {
      toast.error(t("login.registrationClosed"));
      return;
    }
    if (mode === "user" && isRegistering && !captchaAnswer.trim()) {
      toast.error(t("login.captchaRequired"));
      return;
    }
    setLoading(true);
    try {
      if (mode === "admin") {
        await api.login(password.trim(), adminEntryPath);
        setAdminToken(password.trim());
      } else {
        const result = isRegistering
          ? await userApi.register(username.trim(), password, displayName.trim() || undefined, captchaId, captchaAnswer.trim())
          : await userApi.login(username.trim(), password);
        setUserToken(result.token);
      }
      toast.success(t("login.ok"));
      localStorage.setItem("localapi_auth_mode", mode);
      onSuccess(mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      toast.error(message || t("login.failed"));
      if (mode === "user" && isRegistering) {
        void loadCaptcha();
      }
    } finally {
      setLoading(false);
    }
  }

  const description = mode === "admin"
    ? (zh ? "使用管理员凭据进入系统控制台。" : "Use administrator credentials to enter the system console.")
    : isRegistering
      ? t("login.registerDesc")
      : noUserLoginMethods
        ? (zh ? "当前未开放任何登录方式，请联系管理员。" : "No login methods are currently enabled. Contact the administrator.")
        : (zh ? "登录后查看余额、套餐、用量与 API Key。" : "Sign in to view balance, plan, usage and API keys.");

  const submitLabel = loading
    ? t("common.loading")
    : isRegistering
      ? t("login.registerSubmit")
      : t("login.submit");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-[360px] space-y-8">
        <div className="flex flex-col items-center space-y-4 text-center">
          <BrandMark name={brandName} tagline={tagline} iconUrl={iconUrl} size="hero" />
          <p className="mx-auto max-w-[280px] text-sm leading-6 text-muted-foreground">{description}</p>
        </div>

        {showPasswordForm ? (
          <form className="space-y-4" onSubmit={submit}>
            {mode === "user" ? (
              <div className="space-y-2">
                <Label htmlFor="username">{zh ? "用户名" : "Username"}</Label>
                <Input
                  id="username"
                  autoFocus
                  className="h-10 rounded-full bg-card px-4"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                />
              </div>
            ) : null}
            {mode === "user" && isRegistering ? (
              <div className="space-y-2">
                <Label htmlFor="display-name">{t("login.displayName")}</Label>
                <Input
                  id="display-name"
                  className="h-10 rounded-full bg-card px-4"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="login-password">{t("login.password")}</Label>
              <Input
                id="login-password"
                type="password"
                autoFocus={mode === "admin"}
                autoComplete={isRegistering ? "new-password" : "current-password"}
                className="h-10 rounded-full bg-card px-4"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={mode === "admin" ? t("login.placeholder") : zh ? "用户密码" : "Password"}
              />
            </div>
            {mode === "user" && isRegistering ? (
              <div className="space-y-2">
                <Label htmlFor="captcha-answer">{t("login.captcha")}</Label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="h-14 w-[180px] shrink-0 overflow-hidden rounded-2xl border border-border bg-card transition-opacity hover:opacity-90 disabled:opacity-60"
                    onClick={() => void loadCaptcha()}
                    disabled={captchaLoading}
                    title={t("login.captchaRefresh")}
                    aria-label={t("login.captchaRefresh")}
                  >
                    {captchaImage ? (
                      <img src={captchaImage} alt={t("login.captcha")} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-xs text-muted-foreground">{captchaLoading ? t("common.loading") : t("login.captchaRefresh")}</span>
                    )}
                  </button>
                  <Input
                    id="captcha-answer"
                    className="h-10 rounded-full bg-card px-4"
                    value={captchaAnswer}
                    onChange={(event) => setCaptchaAnswer(event.target.value)}
                    placeholder={t("login.captchaPlaceholder")}
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </div>
              </div>
            ) : null}
            <Button type="submit" className="h-10 w-full rounded-full px-4 text-sm" disabled={loading}>
              {submitLabel}
            </Button>
          </form>
        ) : null}

        {showLinuxdo ? (
          <div className="space-y-4">
            {showPasswordForm ? (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>{zh ? "或" : "or"}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            <Button type="button" variant="outline" className="h-10 w-full rounded-full px-4 text-sm" onClick={() => { window.location.href = "/user/api/auth/linuxdo"; }}>
              {registration.data?.linuxdo_registration_enabled
                ? (zh ? "使用 LinuxDo 登录 / 注册" : "Continue with LinuxDo")
                : (zh ? "使用 LinuxDo 登录" : "Sign in with LinuxDo")}
            </Button>
          </div>
        ) : null}

        {mode === "user" && passwordRegistrationEnabled ? (
          <div className="text-center text-xs text-muted-foreground">
            {isRegistering ? (
              <>
                {zh ? "已有账号？" : "Already have an account?"}{" "}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
                  onClick={() => setIsRegistering(false)}
                >
                  {zh ? "登录" : "Sign in"}
                </button>
              </>
            ) : (
              <>
                {zh ? "还没有账号？" : "Don't have an account?"}{" "}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2 transition-colors hover:text-foreground/80"
                  onClick={() => setIsRegistering(true)}
                >
                  {zh ? "注册" : "Sign up"}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>

      {companyName ? (
        <footer className="fixed bottom-4 left-0 right-0 px-4 text-center text-[11px] text-muted-foreground/60">
          @{new Date().getFullYear()} {companyName}
        </footer>
      ) : null}
    </div>
  );
}

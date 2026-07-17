import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, setAdminToken, setUserToken, userApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";

const BRAND_CACHE_KEY = "localapi_brand_name";
const COMPANY_CACHE_KEY = "localapi_company_name";

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
  const branding = useQuery({ queryKey: ["branding"], queryFn: api.branding, staleTime: 60_000 });
  const registration = useQuery({ queryKey: ["user-config"], queryFn: userApi.config, staleTime: 30_000, enabled: mode === "user" });
  const brandName = branding.data?.brand_name || localStorage.getItem(BRAND_CACHE_KEY) || t("shell.brand");
  const companyName = branding.data?.company_name?.trim() || localStorage.getItem(COMPANY_CACHE_KEY) || "";
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = brandName;
  }, [brandName]);

  useEffect(() => {
    if (!branding.data) return;
    localStorage.setItem(BRAND_CACHE_KEY, branding.data.brand_name || "LocalAPI");
    if (branding.data.company_name?.trim()) localStorage.setItem(COMPANY_CACHE_KEY, branding.data.company_name.trim());
    else localStorage.removeItem(COMPANY_CACHE_KEY);
  }, [branding.data]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!password.trim()) {
      toast.error(t("login.required"));
      return;
    }
    if (mode === "user" && !username.trim()) {
      toast.error(zh ? "请输入用户名" : "Username is required");
      return;
    }
    if (mode === "user" && isRegistering && !registration.data?.registration_enabled) {
      toast.error(t("login.registrationClosed"));
      return;
    }
    setLoading(true);
    try {
      if (mode === "admin") {
        await api.login(password.trim(), adminEntryPath);
        setAdminToken(password.trim());
      } else {
        const result = isRegistering
          ? await userApi.register(username.trim(), password, displayName.trim() || undefined)
          : await userApi.login(username.trim(), password);
        setUserToken(result.token);
      }
      toast.success(t("login.ok"));
      localStorage.setItem("localapi_auth_mode", mode);
      onSuccess(mode);
    } catch {
      toast.error(t("login.failed"));
    } finally {
      setLoading(false);
    }
  }

  const description = mode === "admin"
    ? (zh ? "使用管理员凭据进入系统控制台。" : "Use administrator credentials to enter the system console.")
    : isRegistering
      ? t("login.registerDesc")
      : (zh ? "登录后查看余额、套餐、用量与 API Key。" : "Sign in to view balance, plan, usage and API keys.");

  const submitLabel = loading
    ? t("common.loading")
    : isRegistering
      ? t("login.registerSubmit")
      : t("login.submit");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-[360px] space-y-8">
        <div className="space-y-3 text-center">
          <h1 className="text-4xl font-medium tracking-tight">{brandName}</h1>
          <p className="mx-auto max-w-[280px] text-sm leading-6 text-muted-foreground">{description}</p>
        </div>

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
          <Button type="submit" className="h-10 w-full rounded-full px-4 text-sm" disabled={loading}>
            {submitLabel}
          </Button>
        </form>

        {mode === "user" && registration.data?.linuxdo_enabled && !isRegistering ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span>{zh ? "或" : "or"}</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button type="button" variant="outline" className="h-10 w-full rounded-full px-4 text-sm" onClick={() => { window.location.href = "/user/api/auth/linuxdo"; }}>
              {zh ? "使用 LinuxDo 登录" : "Continue with LinuxDo"}
            </Button>
          </div>
        ) : null}

        {mode === "user" && registration.data?.registration_enabled ? (
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

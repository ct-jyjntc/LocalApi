import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesCombined, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, setAdminToken, setUserToken, userApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

  const title = mode === "admin"
    ? t("login.title")
    : isRegistering
      ? t("login.registerTitle")
      : zh ? "欢迎回来" : "Welcome back";
  const description = mode === "admin"
    ? (zh ? "使用管理员凭据进入系统控制台。" : "Use administrator credentials to enter the system console.")
    : isRegistering
      ? t("login.registerDesc")
      : zh ? "登录后查看余额、套餐、用量与 API Key。" : "Sign in to view balance, plan, usage and API keys.";

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center border-b border-border/60 px-4 sm:px-6">
        <span className="truncate text-sm font-semibold">{brandName}</span>
      </header>

      <main className="grid min-h-0 flex-1 lg:grid-cols-[1fr_1px_1fr]">
        <section className="hidden items-center justify-center px-10 py-12 lg:flex">
          <div className="w-full max-w-[440px] space-y-8">
            <div>
              <p className="text-xs text-muted-foreground">{zh ? "统一 API 中转控制台" : "Unified API relay console"}</p>
              <h1 className="mt-3 max-w-md text-3xl font-medium tracking-tight">
                {zh ? "安静、清晰地管理每一次模型调用。" : "Manage every model call with clarity."}
              </h1>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                {zh ? "统一接入渠道、密钥、计费和套餐，让调用状态与成本保持可见。" : "Bring channels, keys, billing and plans into one precise operating surface."}
              </p>
            </div>
            <div className="grid gap-2">
              <Feature icon={ChartNoAxesCombined} text={zh ? "用量与费用清晰可查" : "Clear usage and billing"} />
              <Feature icon={KeyRound} text={zh ? "独立 API Key 与限制策略" : "Independent API keys and limits"} />
              <Feature icon={ShieldCheck} text={zh ? "管理入口与用户入口隔离" : "Separated admin and user access"} />
            </div>
          </div>
        </section>

        <div className="hidden bg-border/70 lg:block" />

        <section className="flex min-w-0 items-center justify-center px-4 py-8 sm:px-8 lg:py-12">
          <Card className="w-full max-w-[360px] space-y-5 p-5 sm:p-6">
            <div className="space-y-3">
              <div className="flex size-8 items-center justify-center rounded-md bg-secondary/60 text-muted-foreground">
                {mode === "admin" ? <ShieldCheck className="size-4" strokeWidth={1.8} /> : <KeyRound className="size-4" strokeWidth={1.8} />}
              </div>
              <div>
                <h2 className="text-xl font-medium tracking-tight">{title}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
              </div>
            </div>

            {mode === "user" && registration.data?.registration_enabled ? (
              <div className="inline-flex h-8 w-full rounded-md bg-muted p-0.5">
                <button type="button" className={`flex-1 rounded-[5px] px-3 text-xs transition-colors ${!isRegistering ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`} onClick={() => setIsRegistering(false)}>{zh ? "登录" : "Sign in"}</button>
                <button type="button" className={`flex-1 rounded-[5px] px-3 text-xs transition-colors ${isRegistering ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`} onClick={() => setIsRegistering(true)}>{zh ? "注册" : "Register"}</button>
              </div>
            ) : null}

            <form className="space-y-3" onSubmit={submit}>
              {mode === "user" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="username">{zh ? "用户名" : "Username"}</Label>
                  <Input id="username" autoFocus className="h-9 bg-card" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
                </div>
              ) : null}
              {mode === "user" && isRegistering ? (
                <div className="space-y-1.5">
                  <Label htmlFor="display-name">{t("login.displayName")}</Label>
                  <Input id="display-name" className="h-9 bg-card" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="login-password">{t("login.password")}</Label>
                <Input
                  id="login-password"
                  type="password"
                  autoFocus={mode === "admin"}
                  autoComplete={isRegistering ? "new-password" : "current-password"}
                  className="h-9 bg-card"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={mode === "admin" ? t("login.placeholder") : zh ? "用户密码" : "Password"}
                />
              </div>
              <Button type="submit" size="sm" className="w-full" disabled={loading}>
                {loading ? t("common.loading") : isRegistering ? t("login.registerSubmit") : t("login.submit")}
              </Button>
            </form>
          </Card>
        </section>
      </main>

      <footer className="min-h-9 shrink-0 px-4 py-2 text-center text-[11px] text-muted-foreground/75 sm:px-6 sm:text-right">
        {companyName ? `@${new Date().getFullYear()} ${companyName}` : ""}
      </footer>
    </div>
  );
}

function Feature({ icon: Icon, text }: { icon: typeof ShieldCheck; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-card px-3.5 py-3 text-xs">
      <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span>{text}</span>
    </div>
  );
}

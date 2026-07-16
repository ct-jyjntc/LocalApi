import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, setAdminToken, setUserToken, userApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";

export function LoginPage({ onSuccess }: { onSuccess: (mode: "admin" | "user") => void }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const branding = useQuery({ queryKey: ["branding"], queryFn: api.branding, staleTime: 60_000 });
  const registration = useQuery({ queryKey: ["user-config"], queryFn: userApi.config, staleTime: 30_000 });
  const brandName = branding.data?.brand_name || t("shell.brand");
  const companyName = branding.data?.company_name?.trim() || "";
  const [mode, setMode] = useState<"admin" | "user">("user");
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = brandName;
  }, [brandName]);

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
        await api.login(password.trim());
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

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex h-12 items-center border-b border-border/60 px-5">
        <span className="text-sm font-semibold">{brandName}</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-5 py-10">
        <Card className="w-full max-w-[336px] space-y-4 p-5">
          <div className="flex flex-col gap-3">
            <div className="inline-flex h-8 rounded-md bg-muted p-0.5">
              <button type="button" className={`flex-1 rounded-[5px] px-3 text-xs ${mode === "user" ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={() => setMode("user")}>{zh ? "用户" : "User"}</button>
              <button type="button" className={`flex-1 rounded-[5px] px-3 text-xs ${mode === "admin" ? "bg-background shadow-sm" : "text-muted-foreground"}`} onClick={() => { setMode("admin"); setIsRegistering(false); }}>{zh ? "管理员" : "Admin"}</button>
            </div>
            <div>
            <h1 className="text-xl font-medium tracking-tight">
              {mode === "admin" ? t("login.title") : isRegistering ? t("login.registerTitle") : zh ? "用户登录" : "User sign-in"}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {mode === "admin" ? t("login.desc") : isRegistering ? t("login.registerDesc") : zh ? "进入用量、余额、套餐和 API Key 控制台。" : "Open your usage, balance, plan and API key console."}
            </p>
            </div>
          </div>
          <form className="space-y-3" onSubmit={submit}>
            {mode === "user" ? (
              <div className="space-y-1.5">
                <Label htmlFor="username">{zh ? "用户名" : "Username"}</Label>
                <Input id="username" autoFocus className="h-9 bg-card" value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
            ) : null}
            {mode === "user" && isRegistering ? (
              <div className="space-y-1.5">
                <Label htmlFor="display-name">{t("login.displayName")}</Label>
                <Input id="display-name" className="h-9 bg-card" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="admin-password">{t("login.password")}</Label>
              <Input
                id="admin-password"
                type="password"
                autoFocus={mode === "admin"}
                autoComplete="current-password"
                className="h-9 bg-card"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "admin" ? t("login.placeholder") : zh ? "用户密码" : "Password"}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="w-full"
              disabled={loading}
            >
              {loading ? t("common.loading") : isRegistering ? t("login.registerSubmit") : t("login.submit")}
            </Button>
          </form>
          {mode === "user" && registration.data?.registration_enabled ? (
            <button type="button" className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => setIsRegistering((value) => !value)}>
              {isRegistering ? t("login.switchToLogin") : t("login.switchToRegister")}
            </button>
          ) : null}
        </Card>
      </div>
      {companyName ? (
        <div className="pointer-events-none fixed bottom-3 right-5 text-[11px] text-muted-foreground/75">
          @{new Date().getFullYear()} {companyName}
        </div>
      ) : null}
    </div>
  );
}

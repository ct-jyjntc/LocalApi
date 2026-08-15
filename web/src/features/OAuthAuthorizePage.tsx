import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, getUserToken, setUserToken, userApi, type UserRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";
import { useBrand } from "@/lib/branding";
import { BrandMark } from "@/components/BrandMark";

/**
 * OAuth consent page for the Pi-Web provider integration.
 *
 * Reached at `/oauth/authorize?state=…` (SPA fallback). Flows:
 * 1. No user session → password login form (reuses /user/api/login).
 * 2. Session present → consent card; allow/deny POSTs to /oauth/authorize.
 * 3. Done → confirmation screen; Pi-Web's poll loop picks up the decision.
 *
 * Deliberately rendered outside <Root /> so the app's verify()/redirect
 * logic never rewrites the URL and drops the `state` parameter.
 */
export function OAuthAuthorizePage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const state = new URLSearchParams(window.location.search).get("state") || "";
  const { brandName, companyName, tagline, iconUrl } = useBrand();
  const [phase, setPhase] = useState<"checking" | "login" | "consent" | "done" | "error">("checking");
  const [me, setMe] = useState<UserRow | null>(null);
  const [decision, setDecision] = useState<"allow" | "deny" | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const verifySession = useCallback(async () => {
    if (!state) {
      setPhase("error");
      return;
    }
    if (!getUserToken()) {
      setPhase("login");
      return;
    }
    try {
      const result = await userApi.me();
      setMe(result.user);
      setPhase("consent");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Token cleared by request(); show the login form.
        setPhase("login");
        return;
      }
      setPhase("error");
    }
  }, [state]);

  useEffect(() => {
    void verifySession();
  }, [verifySession]);

  async function submitLogin(e?: FormEvent) {
    e?.preventDefault();
    if (!username.trim() || !password) {
      toast.error(zh ? "请输入用户名和密码" : "Username and password are required");
      return;
    }
    setLoading(true);
    try {
      const result = await userApi.login(username.trim(), password);
      setUserToken(result.token);
      setMe(result.user);
      setPhase("consent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (zh ? "登录失败" : "Login failed"));
    } finally {
      setLoading(false);
    }
  }

  async function decide(action: "allow" | "deny") {
    setLoading(true);
    try {
      await userApi.oauth.authorize(state, action);
      setDecision(action);
      setPhase("done");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setPhase("login");
      } else {
        toast.error(error instanceof Error ? error.message : (zh ? "授权失败" : "Authorization failed"));
      }
    } finally {
      setLoading(false);
    }
  }

  const displayName = me?.display_name || me?.username || "";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-[400px] space-y-6">
        <div className="flex flex-col items-center space-y-4 text-center">
          <BrandMark name={brandName} tagline={tagline} iconUrl={iconUrl} size="hero" />
          {phase !== "error" ? (
            <p className="mx-auto max-w-[320px] text-sm leading-6 text-muted-foreground">
              {zh ? "Pi-Web 请求访问你的账号" : "Pi-Web is requesting access to your account"}
            </p>
          ) : null}
        </div>

        {phase === "checking" ? (
          <p className="text-center text-xs text-muted-foreground">{zh ? "正在验证登录状态…" : "Checking session…"}</p>
        ) : null}

        {phase === "error" ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center">
            <p className="text-sm text-destructive">{zh ? "授权请求无效或已过期" : "Invalid or expired authorization request"}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {zh ? "请回到 Pi-Web 重新发起登录。" : "Please start again from Pi-Web."}
            </p>
          </div>
        ) : null}

        {phase === "login" ? (
          <form className="space-y-4" onSubmit={submitLogin}>
            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-xs text-muted-foreground">
                {zh ? `登录后授权 Pi-Web 使用你的 ${brandName} 账号。` : `Sign in to authorize Pi-Web on your ${brandName} account.`}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="oauth-username">{zh ? "用户名" : "Username"}</Label>
              <Input
                id="oauth-username"
                autoFocus
                className="h-10 rounded-full bg-card px-4"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="oauth-password">{zh ? "密码" : "Password"}</Label>
              <Input
                id="oauth-password"
                type="password"
                autoComplete="current-password"
                className="h-10 rounded-full bg-card px-4"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button type="submit" className="h-10 w-full rounded-full px-4 text-sm" disabled={loading}>
              {loading ? (zh ? "登录中…" : "Signing in…") : (zh ? "登录" : "Sign in")}
            </Button>
          </form>
        ) : null}

        {phase === "consent" ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-sm">
                {zh ? "授权" : "Authorize"}{" "}
                <span className="font-medium text-foreground">Pi-Web</span>
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {zh ? `以 ${displayName} 的身份：` : `as ${displayName}:`}
              </p>
              <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                <li>· {zh ? "读取可用模型列表" : "Read the available model list"}</li>
                <li>
                  {zh
                    ? "以你的身份调用模型（按订阅套餐配额或钱包余额计费）"
                    : "Call models on your behalf (billed to your subscription plan or wallet balance)"}
                </li>
              </ul>
            </div>
            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-10 flex-1 rounded-full px-4 text-sm"
                onClick={() => void decide("deny")}
                disabled={loading}
              >
                {zh ? "拒绝" : "Deny"}
              </Button>
              <Button
                type="button"
                className="h-10 flex-1 rounded-full px-4 text-sm"
                onClick={() => void decide("allow")}
                disabled={loading}
              >
                {loading ? (zh ? "提交中…" : "Submitting…") : (zh ? "授权" : "Allow")}
              </Button>
            </div>
          </div>
        ) : null}

        {phase === "done" ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center">
            <p className="text-sm">
              {decision === "allow"
                ? (zh ? "已授权，请返回 Pi-Web 继续。" : "Authorized — return to Pi-Web to continue.")
                : (zh ? "已拒绝，请返回 Pi-Web。" : "Denied — return to Pi-Web.")}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {zh ? "此窗口现在可以关闭。" : "You can close this window now."}
            </p>
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

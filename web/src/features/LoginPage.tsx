import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, setAdminToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n";

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!password.trim()) {
      toast.error(t("login.required"));
      return;
    }
    setLoading(true);
    try {
      await api.login(password.trim());
      setAdminToken(password.trim());
      toast.success(t("login.ok"));
      onSuccess();
    } catch {
      toast.error(t("login.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex h-12 items-center border-b border-border/60 px-5">
        <span className="text-sm font-semibold">{t("shell.brand")}</span>
      </div>
      <div className="flex flex-1 items-center justify-center px-5 py-10">
        <Card className="w-full max-w-[336px] space-y-4 p-5">
          <div>
            <h1 className="text-xl font-medium tracking-tight">
              {t("login.title")}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("login.desc")}
            </p>
          </div>
          <form className="space-y-3" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="admin-password">{t("login.password")}</Label>
              <Input
                id="admin-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                className="h-9 bg-card"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("login.placeholder")}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="w-full"
              disabled={loading}
            >
              {loading ? t("common.loading") : t("login.submit")}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

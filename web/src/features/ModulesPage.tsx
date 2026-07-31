import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, Power, PowerOff, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { api, type InstalledModule } from "@/lib/api";
import { PageHeader } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useAppDialog } from "@/components/app-dialog-context";

export function ModulesPage() {
  const qc = useQueryClient();
  const dialogs = useAppDialog();
  const fileRef = useRef<HTMLInputElement>(null);
  const [activateOnInstall, setActivateOnInstall] = useState(true);
  const [purgeOnUninstall, setPurgeOnUninstall] = useState(false);

  const modules = useQuery({
    queryKey: ["admin-modules"],
    queryFn: () => api.modules.list(),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin-modules"] });
    void qc.invalidateQueries({ queryKey: ["modules-public"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({ queryKey: ["payment-channels"] });
    void qc.invalidateQueries({ queryKey: ["payment-channel"] });
  };

  const install = useMutation({
    mutationFn: (file: File) => api.modules.install(file, activateOnInstall),
    onSuccess: (mod) => {
      toast.success(`已安装 ${mod.name} v${mod.version}${mod.active ? " 并启用" : ""}`);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const activate = useMutation({
    mutationFn: (id: string) => api.modules.activate(id),
    onSuccess: (mod) => {
      toast.success(`已启用 ${mod.name}`);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.modules.deactivate(id),
    onSuccess: (mod) => {
      toast.success(`已停用 ${mod.name}`);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const uninstall = useMutation({
    mutationFn: (id: string) => api.modules.uninstall(id, purgeOnUninstall),
    onSuccess: () => {
      toast.success("模块已卸载");
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const items = modules.data?.items ?? [];
  const busy = install.isPending || activate.isPending || deactivate.isPending || uninstall.isPending;

  const sorted = useMemo(
    () => [...items].sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  );

  const onPickFile = (file?: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("请上传 .zip 模块包");
      return;
    }
    install.mutate(file);
  };

  const requestUninstall = async (mod: InstalledModule) => {
    const ok = await dialogs.confirm({
      title: `卸载 ${mod.name}`,
      description: purgeOnUninstall
        ? "将删除模块文件、停用相关功能，并清除该模块写入的设置项。历史支付订单会保留。"
        : "将删除模块文件并停用相关功能。设置与历史订单会保留，便于稍后重装恢复。",
      confirmText: "卸载",
      destructive: true,
    });
    if (ok) uninstall.mutate(mod.id);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="模块"
        description="安装、启用或卸载 zip 功能模块。LinuxDo 登录与 Credit 支付已拆分为可装卸模块。"
      />

      <Card className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">安装模块</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              上传由 <code className="rounded bg-secondary px-1 py-0.5">npm run package:linuxdo</code> 生成的 zip。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md bg-secondary/55 px-3 py-2">
            <span className="text-xs text-muted-foreground">安装后启用</span>
            <Switch checked={activateOnInstall} onCheckedChange={setActivateOnInstall} />
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            onPickFile(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload />
            {install.isPending ? "安装中…" : "上传 zip 安装"}
          </Button>
          <div className="flex items-center gap-2 rounded-md bg-secondary/40 px-3 py-2 text-[11px] text-muted-foreground">
            <Switch checked={purgeOnUninstall} onCheckedChange={setPurgeOnUninstall} />
            卸载时清除模块设置
          </div>
        </div>
      </Card>

      <div className="space-y-3">
        {modules.isLoading ? (
          <Card className="p-4 text-xs text-muted-foreground">加载模块列表…</Card>
        ) : null}
        {modules.error ? (
          <Card className="p-4 text-xs text-destructive">
            {(modules.error as Error).message || "无法加载模块"}
          </Card>
        ) : null}
        {!modules.isLoading && sorted.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <Package className="size-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">尚未安装模块</p>
            <p className="max-w-sm text-[11px] text-muted-foreground">
              安装 LinuxDo 模块后，可在设置中配置 OAuth，并在支付页配置 Credit 渠道。
            </p>
          </Card>
        ) : null}
        {sorted.map((mod) => (
          <Card key={mod.id} className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium">{mod.name}</h3>
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    v{mod.version}
                  </Badge>
                  <Badge variant={mod.active ? "default" : "secondary"}>
                    {mod.active ? "运行中" : mod.enabled ? "已标记启用" : "已停用"}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {mod.description || "无描述"} · id <code className="font-mono">{mod.id}</code>
                </p>
                {mod.features?.length ? (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {mod.features.map((feature) => (
                      <Badge key={feature} variant="outline" className="font-mono text-[10px]">
                        {feature}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <p className="pt-1 text-[10px] text-muted-foreground">
                  安装于 {mod.installed_at || "—"} · 更新于 {mod.updated_at || "—"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {mod.active ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => deactivate.mutate(mod.id)}
                  >
                    <PowerOff />
                    停用
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => activate.mutate(mod.id)}>
                    <Power />
                    启用
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void requestUninstall(mod)}
                >
                  <Trash2 />
                  卸载
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

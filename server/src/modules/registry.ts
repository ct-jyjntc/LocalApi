import fs from "fs";
import path from "path";
import { db, deleteSetting, getDataDir, getSetting } from "../db";
import { nowIso } from "../utils/time";
import { ModuleHostRouter } from "./host-router";
import {
  buildModuleContext,
  createModuleRuntimeHandles,
  teardownModuleHandles,
  type ModuleRuntimeHandles,
} from "./context";
import { loadModuleDefinition, readModuleManifest } from "./loader";
import { extractModuleZip } from "./zip";
import type {
  AdminModuleInfo,
  InstalledModuleRecord,
  ModuleDefinition,
  ModuleManifest,
  PublicModuleInfo,
} from "./types";

const CORE_VERSION = "1.0.0";

function modulesRoot() {
  return path.join(getDataDir(), "modules");
}

function moduleDir(id: string) {
  return path.join(modulesRoot(), id);
}

function bundledModuleDir(id: string) {
  const candidates = [
    path.resolve(__dirname, "../../bundled-modules", id),
    path.resolve(process.cwd(), "bundled-modules", id),
    path.resolve(process.cwd(), "server/bundled-modules", id),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "module.json"))) || null;
}

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function rmrf(target: string) {
  fs.rmSync(target, { recursive: true, force: true });
}

function parseVersion(value: string) {
  return value.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function versionGte(current: string, minimum: string) {
  const a = parseVersion(current);
  const b = parseVersion(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function getModuleRow(id: string) {
  return (
    (db.prepare("SELECT * FROM modules WHERE id = ?").get(id) as InstalledModuleRecord | undefined) ?? null
  );
}

function upsertModuleRow(manifest: ModuleManifest, enabled: boolean) {
  const now = nowIso();
  const existing = getModuleRow(manifest.id);
  if (existing) {
    db.prepare(
      `UPDATE modules SET name = ?, version = ?, enabled = ?, updated_at = ?, manifest_json = ? WHERE id = ?`,
    ).run(
      manifest.name,
      manifest.version,
      enabled ? 1 : 0,
      now,
      JSON.stringify(manifest),
      manifest.id,
    );
  } else {
    db.prepare(
      `INSERT INTO modules (id, name, version, enabled, installed_at, updated_at, manifest_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      manifest.id,
      manifest.name,
      manifest.version,
      enabled ? 1 : 0,
      now,
      now,
      JSON.stringify(manifest),
    );
  }
}

function legacyLinuxDoUsed() {
  const clientId = getSetting("linuxdo_client_id")?.trim() || "";
  const loginEnabled = (getSetting("linuxdo_login_enabled") ?? "false") === "true";
  const channel = db
    .prepare("SELECT client_id, client_secret, enabled FROM payment_channels WHERE id = 'linuxdo-credit'")
    .get() as { client_id: string; client_secret: string; enabled: number } | undefined;
  const hasChannelCreds = Boolean(channel?.client_id?.trim() || channel?.client_secret);
  const orderCount = (
    db.prepare("SELECT COUNT(*) AS c FROM payment_orders WHERE channel_id = 'linuxdo-credit'").get() as {
      c: number;
    }
  ).c;
  return Boolean(clientId || loginEnabled || hasChannelCreds || orderCount > 0);
}

export class ModuleRegistry {
  readonly userHost = new ModuleHostRouter();
  readonly adminHost = new ModuleHostRouter();
  readonly paymentHost = new ModuleHostRouter();
  private readonly active = new Map<string, { definition: ModuleDefinition; handles: ModuleRuntimeHandles; manifest: ModuleManifest }>();
  private booted = false;

  listInstalled(): AdminModuleInfo[] {
    const rows = db.prepare("SELECT * FROM modules ORDER BY installed_at, id").all() as InstalledModuleRecord[];
    return rows.map((row) => {
      let features: string[] = [];
      let description = "";
      try {
        const manifest = JSON.parse(row.manifest_json || "{}") as ModuleManifest;
        features = Array.isArray(manifest.features) ? manifest.features : [];
        description = manifest.description || "";
      } catch {
        features = [];
      }
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        description,
        enabled: row.enabled === 1,
        active: this.active.has(row.id),
        features,
        installed_at: row.installed_at,
        updated_at: row.updated_at,
      };
    });
  }

  listPublic(): PublicModuleInfo[] {
    return this.listInstalled()
      .filter((item) => item.enabled && item.active)
      .map(({ id, name, version, description, enabled, features }) => ({
        id,
        name,
        version,
        description,
        enabled,
        features,
      }));
  }

  hasFeature(feature: string) {
    return this.listPublic().some((mod) => mod.features.includes(feature));
  }

  collectAdminSettings() {
    const merged: Record<string, unknown> = {};
    for (const active of this.active.values()) {
      const contribution = active.handles.settings.get(active.manifest.id);
      if (!contribution) continue;
      Object.assign(merged, contribution.serialize());
    }
    return merged;
  }

  applyAdminSettings(body: Record<string, unknown>) {
    for (const active of this.active.values()) {
      const contribution = active.handles.settings.get(active.manifest.id);
      if (!contribution) continue;
      contribution.apply(body);
    }
  }

  installFromZip(zipBuffer: Buffer, options: { activate?: boolean } = {}) {
    const tempRoot = path.join(modulesRoot(), `.tmp-install-${Date.now()}`);
    rmrf(tempRoot);
    try {
      extractModuleZip(zipBuffer, tempRoot);
      // Support zips that wrap contents in a single top-level folder.
      let sourceDir = tempRoot;
      const children = fs.readdirSync(tempRoot);
      if (children.length === 1) {
        const only = path.join(tempRoot, children[0]);
        if (fs.statSync(only).isDirectory() && fs.existsSync(path.join(only, "module.json"))) {
          sourceDir = only;
        }
      }
      const manifest = readModuleManifest(sourceDir);
      if (manifest.minCoreVersion && !versionGte(CORE_VERSION, manifest.minCoreVersion)) {
        throw new Error(`Module requires core >= ${manifest.minCoreVersion}`);
      }
      const dest = moduleDir(manifest.id);
      if (this.active.has(manifest.id)) {
        this.deactivate(manifest.id);
      }
      rmrf(dest);
      fs.mkdirSync(modulesRoot(), { recursive: true });
      copyDir(sourceDir, dest);
      upsertModuleRow(manifest, false);
      if (options.activate !== false) {
        this.activate(manifest.id);
      }
      return this.listInstalled().find((item) => item.id === manifest.id)!;
    } finally {
      rmrf(tempRoot);
    }
  }

  installFromDirectory(sourceDir: string, options: { activate?: boolean } = {}) {
    const manifest = readModuleManifest(sourceDir);
    if (manifest.minCoreVersion && !versionGte(CORE_VERSION, manifest.minCoreVersion)) {
      throw new Error(`Module requires core >= ${manifest.minCoreVersion}`);
    }
    const dest = moduleDir(manifest.id);
    if (this.active.has(manifest.id)) this.deactivate(manifest.id);
    rmrf(dest);
    fs.mkdirSync(modulesRoot(), { recursive: true });
    copyDir(sourceDir, dest);
    upsertModuleRow(manifest, false);
    if (options.activate) this.activate(manifest.id);
    return this.listInstalled().find((item) => item.id === manifest.id)!;
  }

  activate(id: string) {
    const row = getModuleRow(id);
    if (!row) throw new Error(`Module ${id} is not installed`);
    if (this.active.has(id)) {
      db.prepare("UPDATE modules SET enabled = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
      return;
    }
    const dir = moduleDir(id);
    const manifest = readModuleManifest(dir);
    if (manifest.minCoreVersion && !versionGte(CORE_VERSION, manifest.minCoreVersion)) {
      throw new Error(`Module requires core >= ${manifest.minCoreVersion}`);
    }
    const definition = loadModuleDefinition(dir, manifest);
    const handles = createModuleRuntimeHandles(this.userHost, this.adminHost, this.paymentHost);
    const ctx = buildModuleContext(id, handles);
    try {
      const result = definition.activate(ctx);
      if (result && typeof (result as Promise<void>).then === "function") {
        // Activation is sync-preferred; still allow promise but surface rejections.
        void (result as Promise<void>).catch((error) => {
          console.error(`[modules] async activate failed for ${id}`, error);
        });
      }
      this.active.set(id, { definition, handles, manifest });
      upsertModuleRow(manifest, true);
    } catch (error) {
      teardownModuleHandles(id, handles);
      throw error;
    }
  }

  deactivate(id: string) {
    const active = this.active.get(id);
    if (active) {
      try {
        const ctx = buildModuleContext(id, active.handles);
        active.definition.deactivate?.(ctx);
      } catch (error) {
        console.error(`[modules] deactivate hook failed for ${id}`, error);
      }
      teardownModuleHandles(id, active.handles);
      this.active.delete(id);
    }
    if (getModuleRow(id)) {
      db.prepare("UPDATE modules SET enabled = 0, updated_at = ? WHERE id = ?").run(nowIso(), id);
    }
  }

  uninstall(id: string, options: { purgeSettings?: boolean } = {}) {
    const active = this.active.get(id);
    const settingKeys = active?.handles.settings.get(id)?.settingKeys ?? [];
    this.deactivate(id);
    db.prepare("DELETE FROM modules WHERE id = ?").run(id);
    rmrf(moduleDir(id));
    if (options.purgeSettings) {
      for (const key of settingKeys) {
        deleteSetting(key);
      }
      // Also drop common linuxdo keys when purging that module.
      if (id === "linuxdo") {
        for (const key of [
          "linuxdo_login_enabled",
          "linuxdo_client_id",
          "linuxdo_client_secret",
          "linuxdo_relay_url",
          "linuxdo_relay_secret",
          "linuxdo_registration_enabled",
        ]) {
          deleteSetting(key);
        }
      }
    }
  }

  loadEnabledModules() {
    const rows = db.prepare("SELECT id FROM modules WHERE enabled = 1 ORDER BY installed_at, id").all() as Array<{
      id: string;
    }>;
    for (const row of rows) {
      try {
        this.activate(row.id);
        console.log(`[modules] activated ${row.id}`);
      } catch (error) {
        console.error(`[modules] failed to activate ${row.id}`, error);
        db.prepare("UPDATE modules SET enabled = 0, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
      }
    }
  }

  migrateLegacyAndBoot() {
    if (this.booted) return;
    this.booted = true;
    fs.mkdirSync(modulesRoot(), { recursive: true });

    // Existing deployments that already used LinuxDo get the bundled module auto-installed.
    if (!getModuleRow("linuxdo") && legacyLinuxDoUsed()) {
      const bundled = bundledModuleDir("linuxdo");
      if (bundled) {
        try {
          this.installFromDirectory(bundled, { activate: true });
          console.log("[modules] migrated legacy LinuxDo into module linuxdo");
        } catch (error) {
          console.error("[modules] failed to migrate bundled linuxdo module", error);
        }
      } else {
        console.warn("[modules] legacy LinuxDo usage detected but bundled module is missing");
      }
    }

    this.loadEnabledModules();
  }
}

export const moduleRegistry = new ModuleRegistry();

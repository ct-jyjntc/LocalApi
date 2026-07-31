import fs from "fs";
import path from "path";
import type { ModuleDefinition, ModuleManifest } from "./types";

function assertSafeRelative(entry: string, label: string) {
  if (!entry || entry.includes("\0")) {
    throw new Error(`Invalid ${label}`);
  }
  if (path.isAbsolute(entry)) {
    throw new Error(`${label} must be a relative path`);
  }
  const normalized = path.normalize(entry).replace(/\\/g, "/");
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized === "..") {
    throw new Error(`${label} must not escape the module directory`);
  }
  return normalized;
}

export function readModuleManifest(moduleDir: string): ModuleManifest {
  const manifestPath = path.join(moduleDir, "module.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("module.json is missing");
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("module.json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("module.json must be an object");
  }
  const manifest = parsed as Partial<ModuleManifest>;
  if (!manifest.id || typeof manifest.id !== "string") throw new Error("module.json.id is required");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(manifest.id)) {
    throw new Error("module.json.id must be alphanumeric (with _ or -)");
  }
  if (!manifest.name || typeof manifest.name !== "string") throw new Error("module.json.name is required");
  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("module.json.version is required");
  }
  if (!manifest.main || typeof manifest.main !== "string") throw new Error("module.json.main is required");
  const main = assertSafeRelative(manifest.main, "module.json.main");
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === "string" ? manifest.description : "",
    main,
    minCoreVersion: typeof manifest.minCoreVersion === "string" ? manifest.minCoreVersion : "1.0.0",
    features: Array.isArray(manifest.features)
      ? manifest.features.filter((item): item is string => typeof item === "string")
      : [],
  };
}

/** Resolve module entry path and prevent directory escape. */
export function resolveModuleEntry(moduleDir: string, main: string) {
  const safeMain = assertSafeRelative(main, "main");
  const resolvedDir = path.resolve(moduleDir);
  const entry = path.resolve(resolvedDir, safeMain);
  if (entry !== resolvedDir && !entry.startsWith(resolvedDir + path.sep)) {
    throw new Error("Module entry escapes the module directory");
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`Module entry not found: ${safeMain}`);
  }
  return entry;
}

function bustRequireCache(entry: string) {
  try {
    const resolved = require.resolve(entry);
    delete require.cache[resolved];
  } catch {
    // ignore unresolved cache keys
  }
}

export function loadModuleDefinition(moduleDir: string, manifest: ModuleManifest): ModuleDefinition {
  const entry = resolveModuleEntry(moduleDir, manifest.main);
  bustRequireCache(entry);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(entry) as ModuleDefinition | { default?: ModuleDefinition };
  const definition = (loaded as { default?: ModuleDefinition }).default ?? (loaded as ModuleDefinition);
  if (!definition || typeof definition.activate !== "function") {
    throw new Error("Module must export activate(ctx)");
  }
  return definition;
}

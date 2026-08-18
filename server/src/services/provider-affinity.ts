import { createHash } from "crypto";
import type { Provider } from "../db";

type AffinityEntry = {
  providerId: string;
  expiresAt: number;
};

export type AffinityContext = {
  model: string | null;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  apiKeyId?: string | null;
  userId?: string | null;
  billingMode?: "wallet" | "coding";
};

const configuredTtl = Number(process.env.PROVIDER_AFFINITY_TTL_MS || 24 * 60 * 60_000);
const AFFINITY_TTL_MS = Number.isFinite(configuredTtl)
  ? Math.max(60_000, Math.floor(configuredTtl))
  : 24 * 60 * 60_000;
const configuredMaxEntries = Number(process.env.PROVIDER_AFFINITY_MAX_ENTRIES || 50_000);
const MAX_AFFINITY_ENTRIES = Number.isFinite(configuredMaxEntries)
  ? Math.max(100, Math.floor(configuredMaxEntries))
  : 50_000;
const affinities = new Map<string, AffinityEntry>();
let writesSinceCleanup = 0;

function headerValue(headers: AffinityContext["headers"], name: string) {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0]?.trim() || "";
  return typeof direct === "string" ? direct.trim() : "";
}

function stringValue(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function explicitConversationId(ctx: AffinityContext, body: Record<string, unknown>) {
  for (const header of [
    "x-conversation-id",
    "x-session-id",
    "x-chat-id",
    "x-prompt-cache-key",
  ]) {
    const value = headerValue(ctx.headers, header);
    if (value) return `${header}:${value}`;
  }

  const direct = stringValue(body, [
    "conversation_id",
    "session_id",
    "chat_id",
    "prompt_cache_key",
    "cache_key",
  ]);
  if (direct) return `body:${direct}`;

  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = stringValue(metadata as Record<string, unknown>, [
      "conversation_id",
      "session_id",
      "chat_id",
      "prompt_cache_key",
      "cache_key",
    ]);
    if (nested) return `metadata:${nested}`;
  }
  return "";
}

function stableConversationSeed(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages)
    ? body.messages.filter((item) => item && typeof item === "object")
    : Array.isArray(body.input)
      ? body.input.filter((item) => item && typeof item === "object")
      : [];
  if (messages.length) {
    const prefix: unknown[] = [];
    let foundUser = false;
    for (const message of messages) {
      const role = String((message as Record<string, unknown>).role || "").toLowerCase();
      if (role === "system" || role === "developer") {
        prefix.push(message);
        continue;
      }
      if (role === "user") {
        prefix.push(message);
        foundUser = true;
        break;
      }
      if (prefix.length === 0) prefix.push(message);
    }
    if (!foundUser && prefix.length === 0) prefix.push(...messages.slice(0, 2));
    const compactPrefix = prefix.map((message) => {
      const record = message as Record<string, unknown>;
      const rawContent = record.content;
      const content = typeof rawContent === "string"
        ? rawContent.slice(0, 16_384)
        : Array.isArray(rawContent)
          ? rawContent.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : "").join("\n").slice(0, 16_384)
          : "";
      return { role: record.role, content };
    });
    const tools = Array.isArray(body.tools)
      ? body.tools.map((tool) => {
          const record = tool && typeof tool === "object" ? tool as Record<string, unknown> : {};
          const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
          return { type: record.type, name: fn.name ?? record.name };
        })
      : null;
    return JSON.stringify({ prefix: compactPrefix, tools });
  }

  if (typeof body.prompt === "string" && body.prompt) {
    return `prompt:${body.prompt.slice(0, 16_384)}`;
  }
  if (typeof body.input === "string" && body.input) {
    return `input:${body.input.slice(0, 16_384)}`;
  }
  return "";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildProviderAffinityKey(ctx: AffinityContext): string | null {
  if (!ctx.model || !ctx.body || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
    return null;
  }
  const body = ctx.body as Record<string, unknown>;
  const conversation = explicitConversationId(ctx, body) || stableConversationSeed(body);
  if (!conversation) return null;
  const scope = [
    ctx.userId || ctx.apiKeyId || "anonymous",
    ctx.billingMode || "wallet",
    ctx.model,
    conversation,
  ].join("\u001f");
  return digest(scope);
}

function cleanupExpired(now: number) {
  for (const [key, entry] of affinities) {
    if (entry.expiresAt <= now) affinities.delete(key);
  }
  while (affinities.size > MAX_AFFINITY_ENTRIES) {
    const oldest = affinities.keys().next().value as string | undefined;
    if (!oldest) break;
    affinities.delete(oldest);
  }
}

export function getProviderAffinity(key: string | null) {
  if (!key) return null;
  const entry = affinities.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    affinities.delete(key);
    return null;
  }
  affinities.delete(key);
  affinities.set(key, { ...entry, expiresAt: Date.now() + AFFINITY_TTL_MS });
  return entry.providerId;
}

export function rememberProviderAffinity(key: string | null, providerId: string) {
  if (!key) return;
  affinities.delete(key);
  affinities.set(key, { providerId, expiresAt: Date.now() + AFFINITY_TTL_MS });
  writesSinceCleanup += 1;
  if (writesSinceCleanup >= 4096 || affinities.size > MAX_AFFINITY_ENTRIES) {
    writesSinceCleanup = 0;
    cleanupExpired(Date.now());
  }
}

export function forgetProviderAffinity(key: string | null, providerId?: string) {
  if (!key) return;
  const entry = affinities.get(key);
  if (!entry || (providerId && entry.providerId !== providerId)) return;
  affinities.delete(key);
}

export function orderProvidersForConversation(
  providers: Provider[],
  affinityKey: string | null,
  random: () => number = Math.random,
) {
  if (providers.length <= 1) return [...providers];
  const preferredId = getProviderAffinity(affinityKey);
  const preferredIndex = preferredId
    ? providers.findIndex((provider) => provider.id === preferredId)
    : -1;
  const start = preferredIndex >= 0
    ? preferredIndex
    : 0;
  return providers.map((_, offset) => providers[(start + offset) % providers.length]);
}

export function resetProviderAffinityForTests() {
  affinities.clear();
  writesSinceCleanup = 0;
}

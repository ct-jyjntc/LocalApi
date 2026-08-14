import { listProxyLibraries, refreshProxyLibrary } from "./proxies";

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Auto-update loop: every tick, refresh every enabled library whose
 * auto_update flag is on and whose update_interval_ms has elapsed since its
 * last successful import. refreshProxyLibrary() guards against concurrent
 * refreshes of the same library.
 */
export function startProxyScheduler() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  tick();
}

export function stopProxyScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    for (const lib of listProxyLibraries()) {
      if (lib.enabled !== 1 || lib.auto_update !== 1) continue;
      const last = lib.last_updated_at ? new Date(lib.last_updated_at).getTime() : 0;
      if (now - last < lib.update_interval_ms) continue;
      try {
        await refreshProxyLibrary(lib.id);
      } catch (error) {
        // A failed fetch must not take the loop down; the next tick retries.
        console.error(`[proxy-scheduler] refresh failed for library ${lib.id} (${lib.name}):`,
          error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    running = false;
  }
}

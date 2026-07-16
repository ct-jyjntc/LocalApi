type WindowState = {
  startedAt: number;
  count: number;
};

const windows = new Map<string, WindowState>();

export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
) {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterMs: 0 };
  }

  let state = windows.get(key);
  if (!state || now - state.startedAt >= windowMs) {
    state = { startedAt: now, count: 0 };
    windows.set(key, state);
  }

  if (state.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(1, windowMs - (now - state.startedAt)),
    };
  }

  state.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, limit - state.count),
    retryAfterMs: 0,
  };
}

export function resetRateLimit(key: string) {
  windows.delete(key);
}

export function clearRateLimits() {
  windows.clear();
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, state] of windows) {
    if (state.startedAt < cutoff) windows.delete(key);
  }
}, 60_000);
cleanupTimer.unref?.();

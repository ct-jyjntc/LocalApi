export type UpstreamTimeout = {
  abort: () => void;
  clear: () => void;
  didTimeout: () => boolean;
  onBodyChunk: (streaming: boolean) => void;
};

export function createUpstreamTimeout(
  controller: AbortController,
  timeoutMs: number,
): UpstreamTimeout {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const abort = () => {
    clear();
    controller.abort();
  };

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  return {
    abort,
    clear,
    didTimeout: () => timedOut,
    // timeout_ms protects connection setup and time-to-first-byte only.
    // Once the body starts (streaming or not), the provider timeout must be
    // released: keeping it armed mid-download would truncate large buffered
    // responses (a partial body with the full content-length already
    // forwarded) even though the upstream is healthy. The proxy's idle timer
    // takes over as the stall detector; REQUEST_MAX_MS still bounds total
    // lifetime.
    onBodyChunk: () => clear(),
  };
}

export function upstreamTimeoutError(cause?: unknown): Error & { code: string } {
  return Object.assign(new Error("Upstream response timed out", { cause }), {
    name: "UpstreamTimeoutError",
    code: "ETIMEDOUT",
  });
}

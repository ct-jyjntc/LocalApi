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
    // For SSE and other streaming responses, timeout_ms protects connection
    // setup and time-to-first-byte. Once data is flowing, the client owns the
    // lifetime of the stream and may cancel it by disconnecting.
    onBodyChunk: (streaming) => {
      if (streaming) clear();
    },
  };
}

export function upstreamTimeoutError(cause?: unknown): Error & { code: string } {
  return Object.assign(new Error("Upstream response timed out", { cause }), {
    name: "UpstreamTimeoutError",
    code: "ETIMEDOUT",
  });
}

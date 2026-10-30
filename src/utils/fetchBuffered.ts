// TASK-440 #9: a fetch deadline must cover the body, not just the headers.
// Clearing the abort timer as soon as fetch() resolves left every caller's
// `await response.json()` unbounded, so a server that sent headers and then
// stalled hung the caller indefinitely. This reads the whole body inside the
// deadline and hands back a buffered response, so nothing after it can wait on
// the network.

export interface BufferedResponse {
  ok: boolean;
  status: number;
  statusText: string;
  // Parsed lazily from the buffered text: callers keep checking `ok` before
  // they parse, and a non-JSON error body only throws if someone reads it.
  json(): Promise<any>;
}

function deadlineError(): Error {
  // Same name a native abort carries, so existing AbortError checks still match.
  const error = new Error('Aborted: request deadline exceeded');
  error.name = 'AbortError';
  return error;
}

export async function fetchBuffered(
  url: string,
  init: RequestInit,
  ms: number
): Promise<BufferedResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = async (): Promise<BufferedResponse> => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json: async () => JSON.parse(text),
    };
  };

  try {
    // Abort the request AND race the timer: not every fetch implementation
    // propagates an abort into an in-flight body read.
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(deadlineError());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

// An error response whose body could not be read in time still carries its
// status: callers branch on status (429, 404, 5xx) before they ever parse, and
// turning a known HTTP failure into a transport timeout would send it into
// their retry ladders (TASK-440 #9, Codex bug-hunter).
function unreadableError(response: Response, cause: unknown): BufferedResponse {
  return {
    ok: false,
    status: response.status,
    statusText: response.statusText,
    json: async () => {
      throw cause;
    },
  };
}

export async function fetchBuffered(
  url: string,
  init: RequestInit,
  ms: number
): Promise<BufferedResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let headers: Response | undefined;

  const read = async (): Promise<BufferedResponse> => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    headers = response;
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (!response.ok) return unreadableError(response, error);
      throw error;
    }
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
      new Promise<BufferedResponse>((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          if (headers && !headers.ok) {
            resolve(unreadableError(headers, deadlineError()));
          } else {
            reject(deadlineError());
          }
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

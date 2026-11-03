export type FreshAuthReason =
  | 'reveal_recovery_phrase'
  | 'verify_backup'
  | 'export_backup'
  | 'export_private_key';
export type FreshAuthFailure =
  'cancelled' | 'unavailable' | 'busy' | 'timeout' | 'failed';

const messages: Record<FreshAuthFailure, string> = {
  cancelled: 'Authentication was cancelled',
  unavailable: 'Authentication is unavailable',
  busy: 'Authentication is already in progress',
  timeout: 'Authentication timed out',
  failed: 'Authentication failed',
};

export class FreshAuthError extends Error {
  readonly code: FreshAuthFailure;

  constructor(code: FreshAuthFailure) {
    super(messages[code]);
    this.name = 'FreshAuthError';
    this.code = code;
  }
}

export interface FreshAuthCapability {
  readonly __brand: 'FreshAuthCapability';
}
export type FreshAuthPrompter = (
  reason: FreshAuthReason,
  signal: AbortSignal
) => Promise<boolean>;

let prompter: FreshAuthPrompter | undefined;
let promptOpen = false;
const capabilities = new WeakMap<
  FreshAuthCapability,
  { reason: FreshAuthReason; readsLeft: number; live: boolean }
>();

export function registerFreshAuthPrompter(p: FreshAuthPrompter): () => void {
  prompter = p;
  return () => {
    if (prompter === p) prompter = undefined;
  };
}

export async function withFreshAuth<T>(
  reason: FreshAuthReason,
  fn: (cap: FreshAuthCapability) => Promise<T>,
  opts?: { maxReads?: number; timeoutMs?: number }
): Promise<T> {
  if (!prompter) throw new FreshAuthError('unavailable');
  if (promptOpen) throw new FreshAuthError('busy');
  promptOpen = true;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const currentPrompter = prompter;
    if (!currentPrompter) throw new FreshAuthError('unavailable');
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new FreshAuthError('timeout'));
      }, opts?.timeoutMs ?? 120000);
    });
    let authenticated: boolean;
    try {
      authenticated = await Promise.race([
        currentPrompter(reason, controller.signal),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof FreshAuthError) throw error;
      throw new FreshAuthError('failed');
    } finally {
      // The timeout bounds the PROMPT only; a long export after a successful
      // prompt must not abort it.
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
    if (!authenticated) throw new FreshAuthError('cancelled');
    const cap = Object.freeze({ __brand: 'FreshAuthCapability' as const });
    capabilities.set(cap, {
      reason,
      readsLeft: opts?.maxReads ?? 1,
      live: true,
    });
    try {
      return await fn(cap);
    } finally {
      const state = capabilities.get(cap)!;
      state.live = false;
      state.readsLeft = 0;
    }
  } finally {
    if (timer) clearTimeout(timer);
    promptOpen = false;
  }
}

export function consumeFreshAuth(
  cap: FreshAuthCapability,
  reason: FreshAuthReason
): void {
  const state = cap && capabilities.get(cap);
  if (
    !state ||
    !state.live ||
    state.readsLeft <= 0 ||
    state.reason !== reason
  ) {
    throw new FreshAuthError('failed');
  }
  state.readsLeft -= 1;
}

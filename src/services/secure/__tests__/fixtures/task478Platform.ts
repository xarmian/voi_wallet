/**
 * TASK-478: the in-memory platform the found-accounts tests share. Used as
 * `jest.mock('@/platform', () =>
 *   require('<this file>').createTask478Platform())`.
 *
 * Every write goes through `__state.fault`, which can make one write reject or
 * hang, and every write is recorded in `__state.writes` so a test can check
 * what reached storage.
 */
export type StorageOp = 'secure.set' | 'secure.delete' | 'kv.set' | 'kv.remove';
export type Fault = (
  op: StorageOp,
  key: string,
  value?: string
) => 'reject' | 'hang' | undefined;

export interface Task478PlatformState {
  fault: Fault | undefined;
  writes: { op: StorageOp; key: string; value?: string }[];
}

export function createTask478Platform() {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const state: Task478PlatformState = { fault: undefined, writes: [] };
  const gate = (
    op: StorageOp,
    key: string,
    value?: string
  ): Promise<void> | undefined => {
    state.writes.push({ op, key, value });
    const fault = state.fault?.(op, key, value);
    if (fault === 'reject')
      return Promise.reject(new Error('injected storage failure'));
    if (fault === 'hang') return new Promise<void>(() => {});
    return undefined;
  };
  return {
    __secure: secure,
    __kv: kv,
    __state: state,
    __reset: () => {
      secure.clear();
      kv.clear();
      state.fault = undefined;
      state.writes.length = 0;
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: async (k: string) => (secure.has(k) ? secure.get(k)! : null),
      setItem: async (k: string, v: string) => {
        const gated = gate('secure.set', k, v);
        if (gated) return gated;
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        const gated = gate('secure.delete', k);
        if (gated) return gated;
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      setItem: async (k: string, v: string) => {
        const gated = gate('kv.set', k, v);
        if (gated) return gated;
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        const gated = gate('kv.remove', k);
        if (gated) return gated;
        kv.delete(k);
      },
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'task478-device-idfv' },
  };
}

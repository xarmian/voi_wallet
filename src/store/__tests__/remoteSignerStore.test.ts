/**
 * TASK-159 — P0 tests for remoteSignerStore (zustand).
 *
 * Three concerns, per acceptance criteria:
 *   1. Persistence — assert NO sensitive material is written to AsyncStorage
 *      (the air-gapped signer's pending request / transaction bytes stay in
 *      memory only), and that only the four whitelisted keys are ever persisted.
 *   2. Replay / duplicate-request prevention — a processed request id is
 *      rejected by `validateRequest`, and that rejection survives a restart
 *      (persisted `processedRequestIds` are re-hydrated by `initialize`).
 *   3. Request state-machine transitions — the `SigningProgress` progression
 *      idle → reviewing → signing → complete (and the error branch), plus the
 *      reset back to idle / request replacement.
 *
 * DR-3 / CLAUDE.md: this is TEST-ONLY — the store/crypto source is never
 * modified. All key material used as leak canaries is REAL algosdk-derived
 * crypto from the shared fixtures (no fabricated bytes). Real secrets are
 * deliberately routed THROUGH the store's in-memory state — as a mnemonic
 * string, as the raw 64-byte secret key, and as a base64 transaction blob — so
 * the "not persisted / not logged" assertions check EVERY serialized encoding
 * (hex, base64, JSON array, JSON object) and would genuinely FAIL if the store
 * ever wrote or logged that state. They are not vacuous.
 *
 * The AsyncStorage mock commits writes only after a microtask (mirroring the
 * real async native module), so every assertion that depends on a durable value
 * must await a flush — that makes the store's fire-and-forget persistence of
 * processed-request ids explicit rather than hidden behind a synchronous mock.
 */

import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';
import {
  REMOTE_SIGNER_CONSTANTS,
  RemoteSignerRequest,
  SignerDeviceInfo,
} from '@/types/remoteSigner';

// getCrypto().randomUUID() backs generateDeviceId (initializeSignerConfig).
// Route it through Node's CSPRNG so the store runs under jest without the
// native/expo platform adapter — real random ids, no fabricated bytes.
jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    getCrypto: () => ({
      randomUUID: (): string => nodeCrypto.randomUUID(),
    }),
  };
});

// In-memory AsyncStorage. The backing map (mock-prefixed so the jest.mock
// factory may close over it) persists across the module's own reads/writes so
// initialize() can re-hydrate what the actions wrote; tests clear it via
// mockAsyncStore in beforeEach. setItem commits only after a microtask so the
// store's non-awaited (fire-and-forget) persistence surfaces in tests.
const mockAsyncStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) =>
      mockAsyncStore.has(key) ? mockAsyncStore.get(key)! : null
    ),
    setItem: jest.fn(async (key: string, value: string) => {
      await Promise.resolve();
      mockAsyncStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      await Promise.resolve();
      mockAsyncStore.delete(key);
    }),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { useRemoteSignerStore } from '../remoteSignerStore';

// Storage keys — mirror the (unexported) STORAGE_KEYS in the source. If the
// source keys ever drift, the persisted-keys whitelist test below catches it.
const STORAGE_KEYS = {
  APP_MODE: '@voi_remote_signer_mode',
  SIGNER_CONFIG: '@voi_signer_config',
  PAIRED_SIGNERS: '@voi_paired_signers',
  PROCESSED_REQUESTS: '@voi_processed_requests',
} as const;
const ALLOWED_KEYS = new Set<string>(Object.values(STORAGE_KEYS));

const setItemMock = AsyncStorage.setItem as jest.Mock;

/** Drain microtasks + the 0ms macrotask queue so deferred writes commit. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every value written to AsyncStorage this test, concatenated. */
function allPersistedValues(): string {
  return setItemMock.mock.calls.map((call) => String(call[1])).join('\n');
}

/** Distinct keys written to AsyncStorage this test. */
function persistedKeys(): string[] {
  return setItemMock.mock.calls.map((call) => String(call[0]));
}

/** Flatten an Error to a scannable string (JSON.stringify(Error) === "{}"). */
function errorToString(err: Error): string {
  return `${err.name}: ${err.message}\n${err.stack ?? ''}`;
}

/**
 * Serialize a console argument so an object/typed-array/Error carrying a secret
 * is surfaced (a naive `String(obj)` collapses to "[object Object]" and
 * `JSON.stringify(new Error(secret))` collapses to "{}", both hiding a leak).
 * Uint8Arrays become plain number arrays so byte-form leaks are seen; Errors
 * expose message + stack.
 */
function serializeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return errorToString(arg);
  try {
    return JSON.stringify(arg, (_key, value) => {
      if (value instanceof Uint8Array) return Array.from(value);
      if (value instanceof Error) return errorToString(value);
      return value;
    });
  } catch {
    return String(arg);
  }
}

/** All console output captured this test, fully serialized. */
function allConsoleOutput(): string {
  return [logSpy, infoSpy, debugSpy, warnSpy, errorSpy]
    .flatMap((spy) => spy.mock.calls)
    .map((call) => call.map(serializeArg).join(' '))
    .join('\n');
}

/**
 * Every plausible serialized encoding of a real secret key. If any of these
 * substrings appears in persisted state or logs, the key leaked.
 */
function secretKeyEncodings(sk: Uint8Array): string[] {
  const buf = Buffer.from(sk);
  return [
    buf.toString('hex'),
    buf.toString('base64'),
    JSON.stringify(Array.from(sk)), // e.g. JSON.stringify(state.txns bytes)
    JSON.stringify(sk), // e.g. {"0":..} if a Uint8Array were stringified
  ];
}

/** Base64 msgpack of a real (harmless self-payment) unsigned transaction. */
function txnBlob(sender: string): string {
  return Buffer.from(
    algosdk.encodeUnsignedTransaction(paymentTxn(sender))
  ).toString('base64');
}

/** A well-formed, currently-valid signing request with `count` real txns. */
function makeRequest(
  overrides: Partial<RemoteSignerRequest> = {},
  count = 1
): RemoteSignerRequest {
  const acct = makeAccount('signer-primary');
  const txns = Array.from({ length: count }, (_, i) => ({
    i,
    b: txnBlob(acct.addr),
    s: acct.addr,
  }));
  return {
    v: REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION,
    t: 'req',
    id: 'req-00000000-0000-4000-8000-000000000001',
    ts: Date.now(),
    net: 'voi',
    gh: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    txns,
    ...overrides,
  };
}

const INITIAL_PROGRESS = {
  currentIndex: 0,
  totalTransactions: 0,
  status: 'idle' as const,
};

let logSpy: jest.SpyInstance;
let infoSpy: jest.SpyInstance;
let debugSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

describe('remoteSignerStore (TASK-159)', () => {
  beforeEach(() => {
    mockAsyncStore.clear();
    // Silence + capture the store's chatty logging (also lets us assert no
    // secret is ever logged).
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Reset the singleton store to a pristine slate (fresh Set/Map instances).
    useRemoteSignerStore.setState({
      appMode: 'wallet',
      isInitialized: false,
      signerConfig: null,
      pendingRequest: null,
      signingProgress: { ...INITIAL_PROGRESS },
      processedRequestIds: new Set<string>(),
      pairedSigners: new Map<string, SignerDeviceInfo>(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Persistence — no sensitive material at rest
  // -------------------------------------------------------------------------
  describe('persistence', () => {
    it('never persists or logs the pending request, its txn bytes, or key material', async () => {
      const canary = makeAccount('leak-canary');
      const acct = makeAccount('signer-primary');
      const blob = txnBlob(acct.addr);

      // Route REAL secrets through in-memory state in three forms: a 25-word
      // mnemonic (meta.desc), the raw 64-byte secret key (attached to the
      // request object), and a base64 transaction blob (txns[].b).
      const request = makeRequest({
        txns: [{ i: 0, b: blob, s: acct.addr }],
        meta: { desc: canary.mnemonic },
      }) as RemoteSignerRequest & { skCanary?: Uint8Array };
      request.skCanary = canary.sk;

      const store = useRemoteSignerStore.getState();
      store.setPendingRequest(request);

      // setPendingRequest is in-memory only — it writes nothing at all.
      expect(setItemMock).not.toHaveBeenCalled();
      expect(useRemoteSignerStore.getState().pendingRequest).toBe(request);

      // Drive EVERY persisting action while the secret-bearing request is set,
      // so a regression that serialized store state (incl. pendingRequest) to
      // disk during any of these would be caught.
      await store.setAppMode('signer');
      await store.initializeSignerConfig('Air-gapped Pixel');
      await store.updateSignerDeviceName('Renamed Signer');
      await store.addPairedSigner({
        deviceId: 'voi-signer-abc',
        pairedAt: Date.now(),
        addresses: [makeAccount('paired').addr],
      });
      await store.updateSignerActivity('voi-signer-abc');
      await store.removePairedSigner('voi-signer-abc');
      store.markRequestProcessed(request.id);
      await flush();

      const canaries = [
        canary.mnemonic,
        blob,
        ...secretKeyEncodings(canary.sk),
      ];

      const persisted = allPersistedValues();
      expect(setItemMock).toHaveBeenCalled(); // guard: writes DID happen…
      for (const secret of canaries) {
        expect(persisted).not.toContain(secret); // …none carried a secret.
      }

      const logs = allConsoleOutput();
      for (const secret of canaries) {
        expect(logs).not.toContain(secret);
      }
    });

    it('only ever writes the four whitelisted storage keys', async () => {
      const store = useRemoteSignerStore.getState();

      await store.setAppMode('signer');
      await store.initializeSignerConfig('Air-gapped Pixel');
      // In-memory-only actions must not add any storage writes.
      store.setPendingRequest(makeRequest());
      store.setSigningProgress({ status: 'signing' });
      await store.addPairedSigner({
        deviceId: 'voi-signer-abc',
        pairedAt: Date.now(),
        addresses: [makeAccount('paired').addr],
      });
      store.markRequestProcessed('req-x');
      await flush();

      const keys = persistedKeys();
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
      // The four persisting actions each wrote their own key.
      expect(new Set(keys)).toEqual(
        new Set([
          STORAGE_KEYS.APP_MODE,
          STORAGE_KEYS.SIGNER_CONFIG,
          STORAGE_KEYS.PAIRED_SIGNERS,
          STORAGE_KEYS.PROCESSED_REQUESTS,
        ])
      );
    });

    it('persisted signer config contains only public device metadata', async () => {
      await useRemoteSignerStore
        .getState()
        .initializeSignerConfig('Air-gapped Pixel');

      const raw = mockAsyncStore.get(STORAGE_KEYS.SIGNER_CONFIG);
      expect(raw).toBeTruthy();
      const config = JSON.parse(raw!);
      // Exactly the public config shape — no key/seed/mnemonic fields.
      expect(new Set(Object.keys(config))).toEqual(
        new Set(['deviceId', 'deviceName', 'requirePinPerTxn'])
      );
      expect(config.deviceId).toMatch(/^voi-signer-/);
      expect(config.deviceName).toBe('Air-gapped Pixel');
    });

    it('re-hydrates paired signers and processed ids across a restart', async () => {
      const store = useRemoteSignerStore.getState();
      const pairedAddr = makeAccount('paired').addr;
      await store.addPairedSigner({
        deviceId: 'voi-signer-xyz',
        deviceName: 'Old Phone',
        pairedAt: 1000,
        addresses: [pairedAddr],
      });
      store.markRequestProcessed('req-persisted-1');
      await flush(); // let the fire-and-forget processed-ids write land

      // Simulate a fresh app launch: wipe in-memory state, keep AsyncStorage.
      useRemoteSignerStore.setState({
        pairedSigners: new Map(),
        processedRequestIds: new Set(),
        isInitialized: false,
      });

      await useRemoteSignerStore.getState().initialize();

      const rehydrated = useRemoteSignerStore.getState();
      expect(rehydrated.isInitialized).toBe(true);
      expect(rehydrated.pairedSigners.get('voi-signer-xyz')).toEqual({
        deviceId: 'voi-signer-xyz',
        deviceName: 'Old Phone',
        pairedAt: 1000,
        addresses: [pairedAddr],
      });
      expect(rehydrated.processedRequestIds.has('req-persisted-1')).toBe(true);
    });

    it('initialize() on empty storage yields safe wallet-mode defaults', async () => {
      await useRemoteSignerStore.getState().initialize();
      const state = useRemoteSignerStore.getState();
      expect(state.appMode).toBe('wallet');
      expect(state.signerConfig).toBeNull();
      expect(state.pairedSigners.size).toBe(0);
      expect(state.processedRequestIds.size).toBe(0);
      expect(state.isInitialized).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Replay / duplicate-request prevention
  // -------------------------------------------------------------------------
  describe('replay prevention', () => {
    it('accepts a fresh request but rejects the same id on replay', () => {
      const store = useRemoteSignerStore.getState();
      const request = makeRequest();

      // First presentation: valid.
      expect(store.validateRequest(request)).toEqual({ valid: true });
      expect(store.isRequestProcessed(request.id)).toBe(false);

      // Signer processes it.
      store.markRequestProcessed(request.id);
      expect(
        useRemoteSignerStore.getState().isRequestProcessed(request.id)
      ).toBe(true);

      // Replay of the identical request id is now rejected as a duplicate,
      // even though every other field is still valid (fresh timestamp etc.).
      const replay = makeRequest({ ts: Date.now() });
      expect(useRemoteSignerStore.getState().validateRequest(replay)).toEqual({
        valid: false,
        error: 'Request has already been processed',
      });
    });

    it('updates the in-memory replay guard synchronously; persistence is fire-and-forget', async () => {
      const store = useRemoteSignerStore.getState();
      store.markRequestProcessed('req-fire');

      // In-session replay protection is effective immediately…
      expect(
        useRemoteSignerStore.getState().processedRequestIds.has('req-fire')
      ).toBe(true);
      // …while the durable write is fire-and-forget: nothing on disk yet.
      expect(
        mockAsyncStore.get(STORAGE_KEYS.PROCESSED_REQUESTS)
      ).toBeUndefined();

      await flush();
      expect(mockAsyncStore.get(STORAGE_KEYS.PROCESSED_REQUESTS)).toBe(
        JSON.stringify(['req-fire'])
      );
    });

    it('keeps the in-memory replay guard even when the durable write fails', async () => {
      // Model a rejected native write (e.g. disk full) for the processed-ids
      // persistence. markRequestProcessed must not throw and must still block
      // replays within the session.
      setItemMock.mockImplementationOnce(async () => {
        throw new Error('disk full');
      });

      const store = useRemoteSignerStore.getState();
      expect(() => store.markRequestProcessed('req-nowrite')).not.toThrow();
      await flush();

      const state = useRemoteSignerStore.getState();
      expect(state.processedRequestIds.has('req-nowrite')).toBe(true);
      expect(state.validateRequest(makeRequest({ id: 'req-nowrite' }))).toEqual(
        {
          valid: false,
          error: 'Request has already been processed',
        }
      );
    });

    // KNOWN GAP (reported, source intentionally NOT modified): markRequestProcessed
    // persists fire-and-forget. If that durable write is rejected (disk full) or
    // the app terminates before it lands, the id is only in the volatile Set —
    // so after a restart the SAME request id is accepted again (replay). The
    // in-session guard held (see test above), but cross-restart durability is
    // best-effort. This it.failing asserts the DESIRED secure behaviour (replay
    // still blocked) and currently fails, documenting the gap without a source fix.
    it.failing(
      'a processed id whose durable write failed is NOT replay-blocked after restart',
      async () => {
        setItemMock.mockImplementationOnce(async () => {
          throw new Error('disk full');
        });

        const store = useRemoteSignerStore.getState();
        store.markRequestProcessed('req-lost');
        await flush();

        // The durable write was rejected — nothing landed on disk.
        expect(
          mockAsyncStore.get(STORAGE_KEYS.PROCESSED_REQUESTS)
        ).toBeUndefined();

        // Restart: only AsyncStorage survives, the in-memory Set is gone.
        useRemoteSignerStore.setState({
          processedRequestIds: new Set(),
          isInitialized: false,
        });
        await useRemoteSignerStore.getState().initialize();

        // DESIRED: replay still rejected. ACTUAL: accepted → this fails, so
        // it.failing turns the documented gap into a green (expected-fail) test.
        expect(
          useRemoteSignerStore
            .getState()
            .validateRequest(makeRequest({ id: 'req-lost' }))
        ).toEqual({
          valid: false,
          error: 'Request has already been processed',
        });
      }
    );

    // KNOWN GAP (reported, source NOT modified): markRequestProcessed persists
    // the WHOLE set each call, fire-and-forget and un-serialized. If two writes
    // land out of order, the older (smaller) set clobbers the newer one on disk,
    // dropping the most recent id — a replay of that id is accepted after a
    // restart. it.failing asserts the DESIRED behaviour (both ids stay blocked)
    // and currently fails, documenting the last-write-wins race.
    it.failing(
      'out-of-order fire-and-forget writes can drop the newer id (replay after restart)',
      async () => {
        // Defer the two processed-id writes and release them in REVERSE order.
        const commits: (() => void)[] = [];
        const deferWrite = (key: string, value: string) =>
          new Promise<void>((resolve) => {
            commits.push(() => {
              mockAsyncStore.set(key, value);
              resolve();
            });
          });
        setItemMock.mockImplementationOnce(deferWrite);
        setItemMock.mockImplementationOnce(deferWrite);

        const store = useRemoteSignerStore.getState();
        store.markRequestProcessed('req-a'); // write #1 persists ["req-a"]
        store.markRequestProcessed('req-b'); // write #2 persists ["req-a","req-b"]

        // Newer write lands first, then the older write overwrites it.
        commits[1]();
        commits[0]();
        await flush();

        // Restart from disk only.
        useRemoteSignerStore.setState({
          processedRequestIds: new Set(),
          isInitialized: false,
        });
        await useRemoteSignerStore.getState().initialize();

        const state = useRemoteSignerStore.getState();
        // DESIRED: both durably blocked. ACTUAL: req-b was clobbered → accepted.
        expect(state.validateRequest(makeRequest({ id: 'req-a' }))).toEqual({
          valid: false,
          error: 'Request has already been processed',
        });
        expect(state.validateRequest(makeRequest({ id: 'req-b' }))).toEqual({
          valid: false,
          error: 'Request has already been processed',
        });
      }
    );

    it('persists processed ids so replays are blocked after a restart', async () => {
      const store = useRemoteSignerStore.getState();
      store.markRequestProcessed('req-replayable');
      await flush();

      expect(mockAsyncStore.get(STORAGE_KEYS.PROCESSED_REQUESTS)).toBe(
        JSON.stringify(['req-replayable'])
      );

      // Fresh launch: only AsyncStorage survives.
      useRemoteSignerStore.setState({
        processedRequestIds: new Set(),
        isInitialized: false,
      });
      await useRemoteSignerStore.getState().initialize();

      const replay = makeRequest({ id: 'req-replayable' });
      expect(useRemoteSignerStore.getState().validateRequest(replay)).toEqual({
        valid: false,
        error: 'Request has already been processed',
      });
    });

    it('marking the same id twice is idempotent (no duplicate set entries)', () => {
      const store = useRemoteSignerStore.getState();
      store.markRequestProcessed('req-dup');
      store.markRequestProcessed('req-dup');
      expect(useRemoteSignerStore.getState().processedRequestIds.size).toBe(1);
    });

    it('markRequestProcessed accumulates ids without dropping earlier ones', async () => {
      const store = useRemoteSignerStore.getState();
      store.markRequestProcessed('req-a');
      store.markRequestProcessed('req-b');
      await flush();

      const ids = useRemoteSignerStore.getState().processedRequestIds;
      expect(ids.has('req-a')).toBe(true);
      expect(ids.has('req-b')).toBe(true);
      expect(mockAsyncStore.get(STORAGE_KEYS.PROCESSED_REQUESTS)).toBe(
        JSON.stringify(['req-a', 'req-b'])
      );
    });

    it('rejects expired, future, wrong-version, wrong-type, and empty requests', () => {
      const store = useRemoteSignerStore.getState();

      // Expired (older than the 5-minute window).
      expect(
        store.validateRequest(
          makeRequest({
            ts: Date.now() - REMOTE_SIGNER_CONSTANTS.MAX_REQUEST_AGE_MS - 1000,
          })
        )
      ).toEqual({
        valid: false,
        error: 'Request has expired (older than 5 minutes)',
      });

      // Future timestamp beyond the 30s clock-skew allowance.
      expect(
        store.validateRequest(makeRequest({ ts: Date.now() + 60_000 }))
      ).toEqual({
        valid: false,
        error: 'Request timestamp is in the future',
      });

      // Unsupported protocol version.
      expect(
        store.validateRequest(
          makeRequest({ v: 2 as unknown as RemoteSignerRequest['v'] })
        )
      ).toEqual({ valid: false, error: 'Unsupported protocol version: 2' });

      // Wrong payload type.
      expect(
        store.validateRequest(
          makeRequest({ t: 'res' as unknown as RemoteSignerRequest['t'] })
        )
      ).toEqual({
        valid: false,
        error: 'Invalid payload type - expected signing request',
      });

      // No transactions.
      expect(store.validateRequest(makeRequest({ txns: [] }))).toEqual({
        valid: false,
        error: 'No transactions in request',
      });
    });

    it('allows a request timestamp within the 30s future clock-skew window', () => {
      const store = useRemoteSignerStore.getState();
      expect(
        store.validateRequest(makeRequest({ ts: Date.now() + 10_000 }))
      ).toEqual({ valid: true });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Request state-machine transitions (SigningProgress)
  // -------------------------------------------------------------------------
  describe('request state transitions', () => {
    it('starts idle with no pending request', () => {
      const state = useRemoteSignerStore.getState();
      expect(state.pendingRequest).toBeNull();
      expect(state.signingProgress).toEqual(INITIAL_PROGRESS);
    });

    it('enters reviewing with the correct txn count on setPendingRequest', () => {
      const request = makeRequest({}, 3);
      useRemoteSignerStore.getState().setPendingRequest(request);

      const state = useRemoteSignerStore.getState();
      expect(state.pendingRequest).toBe(request);
      expect(state.signingProgress).toEqual({
        currentIndex: 0,
        totalTransactions: 3,
        status: 'reviewing',
      });
    });

    it('progresses reviewing → signing → complete, preserving the txn total', () => {
      const store = useRemoteSignerStore.getState();
      store.setPendingRequest(makeRequest({}, 2));

      store.setSigningProgress({ status: 'signing', currentIndex: 1 });
      expect(useRemoteSignerStore.getState().signingProgress).toEqual({
        currentIndex: 1,
        totalTransactions: 2,
        status: 'signing',
      });

      store.setSigningProgress({ status: 'complete', currentIndex: 2 });
      expect(useRemoteSignerStore.getState().signingProgress).toEqual({
        currentIndex: 2,
        totalTransactions: 2,
        status: 'complete',
      });
    });

    it('supports the error branch with a message', () => {
      const store = useRemoteSignerStore.getState();
      store.setPendingRequest(makeRequest({}, 1));
      store.setSigningProgress({ status: 'error', error: 'user rejected' });

      expect(useRemoteSignerStore.getState().signingProgress).toEqual({
        currentIndex: 0,
        totalTransactions: 1,
        status: 'error',
        error: 'user rejected',
      });
    });

    it('merges partially: recovering from error requires clearing it explicitly', () => {
      const store = useRemoteSignerStore.getState();
      store.setPendingRequest(makeRequest({}, 1));
      store.setSigningProgress({ status: 'error', error: 'boom' });

      // setSigningProgress does a shallow merge, so flipping status back to
      // 'signing' alone does NOT drop the prior `error` field. This documents
      // the store's merge contract (the SigningProgress type intends `error`
      // only when status === 'error', so a clean recovery must clear it).
      store.setSigningProgress({ status: 'signing', currentIndex: 1 });
      expect(useRemoteSignerStore.getState().signingProgress).toEqual({
        currentIndex: 1,
        totalTransactions: 1,
        status: 'signing',
        error: 'boom',
      });

      // A caller recovering cleanly clears it explicitly.
      store.setSigningProgress({ error: undefined });
      expect(
        useRemoteSignerStore.getState().signingProgress.error
      ).toBeUndefined();
    });

    it('resets to idle and clears the request when set to null', () => {
      const store = useRemoteSignerStore.getState();
      store.setPendingRequest(makeRequest({}, 2));
      store.setSigningProgress({ status: 'signing', currentIndex: 1 });

      store.setPendingRequest(null);

      const state = useRemoteSignerStore.getState();
      expect(state.pendingRequest).toBeNull();
      expect(state.signingProgress).toEqual(INITIAL_PROGRESS);
    });

    it('replacing an in-flight request resets progress and drops any stale error', () => {
      const store = useRemoteSignerStore.getState();
      // First request advances into an error state.
      store.setPendingRequest(makeRequest({ id: 'req-first' }, 3));
      store.setSigningProgress({
        status: 'error',
        currentIndex: 2,
        error: 'boom',
      });

      // A brand-new request arrives while the previous one is errored.
      const next = makeRequest({ id: 'req-next' }, 1);
      store.setPendingRequest(next);

      const state = useRemoteSignerStore.getState();
      expect(state.pendingRequest).toBe(next);
      // Progress is fully reset for the new request — index/total/status…
      expect(state.signingProgress).toEqual({
        currentIndex: 0,
        totalTransactions: 1,
        status: 'reviewing',
      });
      // …and crucially no stale error carried over.
      expect(state.signingProgress.error).toBeUndefined();
    });

    it('setPendingRequest does not mark the request processed', () => {
      const request = makeRequest();
      useRemoteSignerStore.getState().setPendingRequest(request);
      // Presenting a request for review must not consume its replay-nonce;
      // only explicit markRequestProcessed does.
      expect(
        useRemoteSignerStore.getState().isRequestProcessed(request.id)
      ).toBe(false);
      expect(useRemoteSignerStore.getState().validateRequest(request)).toEqual({
        valid: true,
      });
    });
  });
});

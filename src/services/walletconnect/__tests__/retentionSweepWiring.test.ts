// Wiring tests for the pre-init WalletConnect retention sweep (PLAN-324,
// TASK-327). The sweep must run exactly once per process, BEFORE the SDK's Core
// is constructed, coalesced across concurrent initializers, native-only, and
// never able to block or fail WalletConnect init.
//
// The retention module itself is mocked here — its behaviour is covered by
// messagesRetention.test.ts. What matters in this file is WHEN it is called.

/** Ordered log of the events whose relative order is the contract. */
const mockCalls: string[] = [];

const mockSweep = jest.fn(async () => {
  mockCalls.push('sweep');
  return { completed: true, main: 'unchanged', withoutAck: 'unchanged' };
});
jest.mock('../messagesRetention', () => ({
  sweepWalletConnectMessageStore: () => mockSweep(),
}));

let mockPlatform: 'mobile' | 'web' | 'extension' = 'mobile';
jest.mock('@/platform/detection', () => ({
  detectPlatform: () => mockPlatform,
  isMobile: () => mockPlatform === 'mobile',
}));

const mockSignClient = {
  session: { getAll: () => [] },
  on: jest.fn(),
  removeAllListeners: jest.fn(),
  pair: jest.fn(async () => {
    mockCalls.push('signClient.pair');
  }),
};
const mockClientInitialize = jest.fn(async () => {
  mockCalls.push('client.initialize');
});
const mockClientDisconnect = jest.fn(async () => {
  mockClientInitialized = false;
});
let mockClientInitialized = false;
jest.mock('../client', () => ({
  WalletConnectClient: {
    getInstance: () => ({
      initialize: async () => {
        await mockClientInitialize();
        mockClientInitialized = true;
      },
      getProvider: () => {
        // Mirrors the real client: no provider until initialize() has run.
        if (!mockClientInitialized) {
          throw new Error('WalletConnect provider not initialized');
        }
        return { client: mockSignClient };
      },
      getCore: () => ({}),
      isInitialized: () => mockClientInitialized,
      disconnect: () => mockClientDisconnect(),
    }),
  },
}));

// Heavy deps index.ts pulls in at load time — stubbed so the module graph
// resolves without native modules (same shape as approveSession.test.ts).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@walletconnect/utils', () => ({
  getSdkError: (key: string) => ({ code: 5100, message: key }),
  buildApprovedNamespaces: ({
    supportedNamespaces,
  }: {
    supportedNamespaces: unknown;
  }) => supportedNamespaces,
}));
jest.mock('@/store/experimentalStore', () => ({
  useExperimentalStore: {
    getState: () => ({ allowUnsupportedNetworks: false }),
  },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: jest.fn(async () => []) },
}));
jest.mock('@/services/secure/keyManager', () => ({ SecureKeyManager: {} }));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: {
    getInstance: () => ({ getSessionData: () => null }),
  },
}));

type ServiceModule = typeof import('../index');

/**
 * Load a FRESH copy of the service module.
 *
 * The once-per-process latch and the shared sweep promise live at module scope
 * (that is the point — they track a process-global SDK singleton), so each test
 * needs its own module registry.
 */
const loadService = (): ServiceModule['WalletConnectService'] => {
  let service!: ServiceModule['WalletConnectService'];
  jest.isolateModules(() => {
    service = (require('../index') as ServiceModule).WalletConnectService;
  });
  return service;
};

beforeEach(() => {
  mockCalls.length = 0;
  mockPlatform = 'mobile';
  mockClientInitialized = false;
  delete (globalThis as unknown as Record<string, unknown>)._walletConnectCore_;
  mockSweep.mockImplementation(async () => {
    mockCalls.push('sweep');
    return { completed: true, main: 'unchanged', withoutAck: 'unchanged' };
  });
  mockClientInitialize.mockImplementation(async () => {
    mockCalls.push('client.initialize');
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)._walletConnectCore_;
  jest.restoreAllMocks();
});

describe('pre-init retention sweep wiring (TASK-327)', () => {
  it('sweeps BEFORE the client (and therefore Core) initializes', async () => {
    await loadService().getInstance().initialize();

    expect(mockCalls).toEqual(['sweep', 'client.initialize']);
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  it('holds Core init until the sweep has finished writing', async () => {
    let releaseSweep!: () => void;
    mockSweep.mockImplementation(() => {
      mockCalls.push('sweep:start');
      return new Promise((resolve) => {
        releaseSweep = () => {
          mockCalls.push('sweep:end');
          resolve({
            completed: true,
            main: 'rewritten',
            withoutAck: 'unchanged',
          });
        };
      });
    });

    const init = loadService().getInstance().initialize();
    await Promise.resolve();
    await Promise.resolve();

    // The sweep is in flight; Core must not have been touched.
    expect(mockClientInitialize).not.toHaveBeenCalled();

    releaseSweep();
    await init;

    expect(mockCalls).toEqual([
      'sweep:start',
      'sweep:end',
      'client.initialize',
    ]);
  });

  it('coalesces concurrent initialize() calls onto ONE sweep', async () => {
    let releaseSweep!: () => void;
    mockSweep.mockImplementation(() => {
      mockCalls.push('sweep:start');
      return new Promise((resolve) => {
        releaseSweep = () =>
          resolve({
            completed: true,
            main: 'unchanged',
            withoutAck: 'unchanged',
          });
      });
    });

    const service = loadService().getInstance();
    const first = service.initialize();
    const second = service.initialize();
    const third = service.initialize();
    await Promise.resolve();
    await Promise.resolve();

    // Every caller is parked on the same sweep — none has reached Core.
    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(mockClientInitialize).not.toHaveBeenCalled();

    releaseSweep();
    await Promise.all([first, second, third]);

    expect(mockSweep).toHaveBeenCalledTimes(1);
    // Nothing touched Core until the sweep was done. (Coalescing the CLIENT
    // init itself is a separate, pre-existing gap — `WalletConnectClient`
    // checks its boolean guard before its first await — and is out of scope
    // here; what this pins down is that no path reaches it early.)
    expect(mockCalls[0]).toBe('sweep:start');
    expect(
      mockCalls.slice(1).every((call) => call === 'client.initialize')
    ).toBe(true);
  });

  it('runs the provider init ONCE for concurrent initialize() calls', async () => {
    const service = loadService().getInstance();
    await Promise.all([
      service.initialize(),
      service.initialize(),
      service.initialize(),
    ]);

    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(mockClientInitialize).toHaveBeenCalledTimes(1);
  });

  it('lets a cold-start pair() wait out an in-flight init instead of failing', async () => {
    // serviceBootstrap starts WalletConnect and DeepLink init in parallel, so a
    // cold-start `wc:` deep link can call pair() while init — now with the
    // sweep in front of it — is still running.
    let releaseSweep!: () => void;
    mockSweep.mockImplementation(() => {
      mockCalls.push('sweep:start');
      return new Promise((resolve) => {
        releaseSweep = () =>
          resolve({
            completed: true,
            main: 'unchanged',
            withoutAck: 'unchanged',
          });
      });
    });

    const service = loadService().getInstance();
    const init = service.initialize();
    const pairing = service.pair('wc:topic@2?relay-protocol=irn&symKey=ab');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSignClient.pair).not.toHaveBeenCalled();

    releaseSweep();
    await Promise.all([init, pairing]);

    expect(mockCalls).toEqual([
      'sweep:start',
      'client.initialize',
      'signClient.pair',
    ]);
  });

  it('reserves the in-flight slot even with no sweep in front (off-native)', async () => {
    // Off-native there is nothing to await before `client.initialize()`, so the
    // run would reach it synchronously if the slot were assigned after the body
    // started — and a re-entrant caller would start a SECOND provider init.
    mockPlatform = 'web';
    const service = loadService().getInstance();
    let reentrant: Promise<void> | undefined;
    mockClientInitialize.mockImplementationOnce(() => {
      reentrant = service.initialize();
      mockCalls.push('client.initialize');
      return Promise.resolve();
    });

    await service.initialize();
    await reentrant;

    expect(mockClientInitialize).toHaveBeenCalledTimes(1);
    expect(mockCalls).toEqual(['client.initialize']);
  });

  it('fails pair() when the in-flight init failed, rather than pairing blind', async () => {
    // Init can fail AFTER the provider exists but before the session handlers
    // are attached; pairing onto that would complete the handshake with nothing
    // listening for the proposal.
    const service = loadService().getInstance();
    mockClientInitialize.mockImplementationOnce(async () => {
      mockCalls.push('client.initialize');
      mockClientInitialized = true;
      throw new Error('handlers not attached');
    });

    const init = service.initialize();
    const pairing = service.pair('wc:topic@2?relay-protocol=irn&symKey=ab');

    await expect(init).rejects.toThrow('handlers not attached');
    await expect(pairing).rejects.toThrow(/Pairing failed/);
    expect(mockSignClient.pair).not.toHaveBeenCalled();
  });

  it('does not sweep when the SDK global Core already exists', async () => {
    // Fast Refresh resets JS module scope — and with it the latch — while the
    // SDK's Core survives on globalThis. Sweeping then would race a live
    // MessageTracker, so the global is the authority, not the latch.
    (globalThis as unknown as Record<string, unknown>)._walletConnectCore_ = {
      pretendCore: true,
    };

    await loadService().getInstance().initialize();

    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockCalls).toEqual(['client.initialize']);
  });

  it('does not sweep if Core appears between scheduling and running', async () => {
    const init = loadService().getInstance().initialize();
    // Synchronously after entry, before the deferred sweep body runs.
    (globalThis as unknown as Record<string, unknown>)._walletConnectCore_ = {
      pretendCore: true,
    };
    await init;

    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockCalls).toEqual(['client.initialize']);
  });

  it('a synchronously re-entrant initialize() still cannot outrun the sweep', async () => {
    // Regression guard for the window where the latch was set but the shared
    // promise had not been assigned yet: a caller re-entering during the sweep
    // would have found `null` and walked straight into Core.
    const service = loadService().getInstance();
    let reentrant: Promise<void> | undefined;
    let releaseSweep!: () => void;
    mockSweep.mockImplementation(() => {
      mockCalls.push('sweep:start');
      // Re-enter WITHOUT awaiting: awaiting here would deadlock on ourselves.
      reentrant = service.initialize();
      return new Promise((resolve) => {
        releaseSweep = () => {
          mockCalls.push('sweep:end');
          resolve({
            completed: true,
            main: 'unchanged',
            withoutAck: 'unchanged',
          });
        };
      });
    });

    const first = service.initialize();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(mockClientInitialize).not.toHaveBeenCalled();

    releaseSweep();
    await Promise.all([first, reentrant]);

    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(mockCalls.indexOf('sweep:end')).toBeLessThan(
      mockCalls.indexOf('client.initialize')
    );
  });

  it('does NOT re-sweep on a re-init after WalletConnectClient.disconnect()', async () => {
    // The service has no disconnect, and its own `initialized` flag would make
    // a second initialize() return early — so drive a genuine re-entry: fail
    // the first init (service stays uninitialized), disconnect the client
    // (which resets ITS flag while the SDK's global Core survives), then
    // initialize again. The irreversible marker must still suppress the sweep.
    mockClientInitialize.mockImplementationOnce(async () => {
      throw new Error('provider init failed');
    });

    const service = loadService().getInstance();
    await expect(service.initialize()).rejects.toThrow('provider init failed');
    expect(mockSweep).toHaveBeenCalledTimes(1);

    await mockClientDisconnect();
    await service.initialize();

    expect(mockClientInitialize).toHaveBeenCalledTimes(2);
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  it('does not sweep again when an initialized service is re-initialized', async () => {
    const service = loadService().getInstance();
    await service.initialize();
    await service.initialize();

    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(mockClientInitialize).toHaveBeenCalledTimes(1);
  });

  it.each(['web', 'extension'] as const)(
    'does not sweep off-native (%s), and initializes normally',
    async (platform) => {
      mockPlatform = platform;

      await loadService().getInstance().initialize();

      expect(mockSweep).not.toHaveBeenCalled();
      expect(mockCalls).toEqual(['client.initialize']);
    }
  );

  it('a rejected sweep neither blocks nor fails WalletConnect init', async () => {
    mockSweep.mockImplementation(async () => {
      mockCalls.push('sweep');
      throw new Error('sweep exploded');
    });

    await expect(
      loadService().getInstance().initialize()
    ).resolves.toBeUndefined();

    expect(mockCalls).toEqual(['sweep', 'client.initialize']);
  });

  it('a sweep that reports failure still lets init proceed', async () => {
    mockSweep.mockImplementation(async () => {
      mockCalls.push('sweep');
      return {
        completed: false,
        main: 'skipped',
        withoutAck: 'skipped',
      };
    });

    await loadService().getInstance().initialize();

    expect(mockCalls).toEqual(['sweep', 'client.initialize']);
  });

  it('adds no runtime SDK event hooks for deletion (DR-5)', async () => {
    await loadService().getInstance().initialize();

    // Only the five session lifecycle handlers the service already installed.
    const events = mockSignClient.on.mock.calls.map((call) => call[0]);
    expect(events).toEqual([
      'session_proposal',
      'session_request',
      'session_update',
      'session_delete',
      'session_expire',
    ]);
  });
});

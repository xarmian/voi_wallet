// A restored WalletConnect v1 session hands its signing requests to the ONE
// DeepLinkService-owned `call_request` listener (TASK-257).
//
// loadV1Sessions() used to add its own listener that, for every request, both
// emitted `session_request` (which the boot navigates on) AND navigated
// directly: the request opened twice. This drives the real loadV1Sessions()
// over a restorable stored row. The session key store is mocked to return a
// placeholder of the right shape; no real key is involved and none is logged.

import { EventEmitter } from 'events';

const mockKv = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: async (k: string, v: string) => {
      mockKv.set(k, v);
    },
    getItem: async (k: string) => (mockKv.has(k) ? mockKv.get(k)! : null),
    removeItem: async (k: string) => {
      mockKv.delete(k);
    },
    getAllKeys: async () => [...mockKv.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => mockKv.delete(k));
    },
  },
}));

const mockV1Client = Object.assign(new EventEmitter(), {
  connect: jest.fn(async () => {}),
  getSessionData: () => ({ handshakeTopic: 'handshake-topic', chainId: 1 }),
});
jest.mock('@/services/walletconnect/v1', () => ({
  get WalletConnectV1Client() {
    return { getInstance: () => mockV1Client };
  },
}));

const mockAttachV1CallRequests = jest.fn();
const mockNavigateToRoute = jest.fn();
jest.mock('@/services/deeplink', () => ({
  DeepLinkService: {
    getInstance: () => ({
      attachV1CallRequests: mockAttachV1CallRequests,
      navigateToRoute: mockNavigateToRoute,
    }),
  },
}));

jest.mock('@/services/walletconnect/v1/sessionKeyStore', () => ({
  readSessionKey: jest.fn(async () => 'placeholder-session-key'),
  writeSessionKey: jest.fn(async () => {}),
  isValidV1SessionKey: () => false,
}));
jest.mock('@/services/walletconnect/v1/sessionCleanup', () => ({
  deleteV1Session: jest.fn(async () => {}),
  deleteV1Sessions: jest.fn(async () => {}),
  topicFromStorageKey: (key: string) => key,
}));

// Heavy deps index.ts pulls in at load time (same shape as
// retentionSweepWiring.test.ts).
jest.mock('../client', () => ({
  WalletConnectClient: { getInstance: () => ({}) },
}));
jest.mock('../messagesRetention', () => ({
  sweepWalletConnectMessageStore: jest.fn(async () => ({})),
}));
jest.mock('@/platform/detection', () => ({
  detectPlatform: () => 'mobile',
  isMobile: () => true,
}));
jest.mock('@walletconnect/utils', () => ({
  getSdkError: (key: string) => ({ code: 5100, message: key }),
  buildApprovedNamespaces: () => ({}),
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

import { WalletConnectService } from '../index';
import { WC_V1_SESSION_STORAGE_KEY } from '../v1/config';

const TOPIC = 'stored-topic';

beforeEach(() => {
  mockKv.clear();
  mockV1Client.removeAllListeners();
  mockKv.set(
    `${WC_V1_SESSION_STORAGE_KEY}:${TOPIC}`,
    JSON.stringify({
      connected: true,
      accounts: [],
      chainId: 416001,
      bridge: 'https://bridge.example',
      clientId: 'client-id',
      peerId: 'peer-id',
      handshakeId: 1,
      handshakeTopic: 'handshake-topic',
      updatedAt: 1,
    })
  );
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('a restored v1 session registers through the single owner and adds no listener of its own', async () => {
  const service = new WalletConnectService();
  const emitted = jest.fn();
  service.on('session_request', emitted);

  await (
    service as unknown as { loadV1Sessions: () => Promise<void> }
  ).loadV1Sessions();

  expect(mockV1Client.connect).toHaveBeenCalledTimes(1);
  expect(mockAttachV1CallRequests).toHaveBeenCalledTimes(1);
  expect(mockAttachV1CallRequests).toHaveBeenCalledWith(mockV1Client, TOPIC);
  expect(mockV1Client.listenerCount('call_request')).toBe(0);

  // A request on the restored session is not ALSO emitted/navigated here.
  mockV1Client.emit('call_request', {
    id: 7,
    method: 'algo_signTxn',
    params: [{ txn: 'opaque' }],
  });
  expect(emitted).not.toHaveBeenCalled();
  expect(mockNavigateToRoute).not.toHaveBeenCalled();
});

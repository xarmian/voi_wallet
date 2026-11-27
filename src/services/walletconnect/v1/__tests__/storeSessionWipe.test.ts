// TASK-469: a v1 session store that a wipe overlaps never writes the slot it
// read before the wipe back. When the store fails after a wipe started, it
// only tries to delete the key it wrote; with no wipe, a failed store still
// rolls the slot back to what was there before.

jest.mock('@/platform', () => ({
  secureStorage: {
    setItem: async () => {},
    getItem: async () => null,
    deleteItem: async () => {},
  },
}));

const mockSetItem = jest.fn(async (_key: string, _value: string) => {});
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: (key: string, value: string) => mockSetItem(key, value),
    getItem: async () => null,
    removeItem: async () => {},
    getAllKeys: async () => [],
    multiRemove: async () => {},
  },
}));

const PRIOR_SLOT = 'prior-slot-from-before';
const mockWriteSessionKey = jest.fn(async (_topic: string, _key: string) => {});
const mockRestoreSlot = jest.fn(async (_prior: string | null) => {});
jest.mock('../sessionKeyStore', () => ({
  ...jest.requireActual('../sessionKeyStore'),
  readSessionKeySlotRaw: async () => PRIOR_SLOT,
  writeSessionKey: (topic: string, key: string) =>
    mockWriteSessionKey(topic, key),
  restoreSessionKeySlot: (prior: string | null) => mockRestoreSlot(prior),
}));

import { WalletConnectV1Client } from '../client';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';

const KEY = 'a1b2c3d4'.repeat(8);

function startWipe() {
  openWipeWindow();
  runWipeResets();
}

function clientWithSession() {
  const client = new (
    WalletConnectV1Client as unknown as new () => WalletConnectV1Client
  )() as unknown as {
    config: unknown;
    sessionData: unknown;
    storeSession: () => Promise<void>;
  };
  client.config = {
    topic: 'topic-b',
    version: '1',
    bridge: 'https://b',
    key: KEY,
  };
  client.sessionData = {
    connected: true,
    accounts: [],
    chainId: 1,
    bridge: 'https://b',
    key: KEY,
    clientId: 'client',
    clientMeta: null,
    peerId: 'peer',
    peerMeta: null,
    handshakeId: 1,
    handshakeTopic: 'handshake',
  };
  return client;
}

beforeEach(() => {
  mockSetItem.mockReset().mockImplementation(async () => {});
  mockWriteSessionKey.mockReset().mockImplementation(async () => {});
  mockRestoreSlot.mockReset().mockImplementation(async () => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  closeWipeWindow();
  jest.restoreAllMocks();
});

describe('v1 storeSession and a wipe', () => {
  it('a wipe that starts mid-store, with the delete of the written key failing, never writes the prior slot back', async () => {
    mockWriteSessionKey.mockImplementation(async () => startWipe());
    mockRestoreSlot.mockImplementation(async () => {
      throw new Error('secure delete failed');
    });
    await clientWithSession().storeSession();
    expect(mockRestoreSlot).toHaveBeenCalled();
    expect(mockRestoreSlot).not.toHaveBeenCalledWith(PRIOR_SLOT);
    expect(mockRestoreSlot.mock.calls.every(([slot]) => slot === null)).toBe(
      true
    );
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('a metadata write that fails after a wipe started deletes the written key, and nothing else', async () => {
    mockSetItem.mockImplementation(async () => {
      startWipe();
      throw new Error('write failed');
    });
    await clientWithSession().storeSession();
    expect(mockRestoreSlot.mock.calls).toEqual([[null]]);
  });

  it('with no wipe, a failed metadata write still rolls the slot back to the prior one', async () => {
    mockSetItem.mockImplementation(async () => {
      throw new Error('write failed');
    });
    await clientWithSession().storeSession();
    expect(mockRestoreSlot.mock.calls).toEqual([[PRIOR_SLOT]]);
  });
});

// The v1 client is a singleton with one connection and has two callers of
// connect: a pairing link and boot session restore. They must never overlap:
// a link still awaiting approval must not have its config and socket replaced
// by a restore, because approving or declining the proposal then acts on the
// restored session (and declining deletes it).

jest.mock('@/platform', () => ({
  secureStorage: {
    setItem: async () => {},
    getItem: async () => null,
    deleteItem: async () => {},
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: async () => {},
    getItem: async () => null,
    removeItem: async () => {},
    getAllKeys: async () => [],
    multiRemove: async () => {},
  },
}));

interface MockSocket {
  bridge: string;
  destroy: jest.Mock;
  releaseConnect: () => void;
}
const mockSockets: MockSocket[] = [];
let mockHoldConnect = false;

jest.mock('../websocket', () => ({
  WalletConnectV1WebSocket: class {
    bridge: string;
    destroy = jest.fn();
    releaseConnect: () => void = () => {};
    constructor(bridge: string) {
      this.bridge = bridge;
      mockSockets.push(this as unknown as MockSocket);
    }
    onStatusChange() {}
    onError() {}
    onTopicMessageWithMeta() {}
    subscribeToTopic = jest.fn(async () => {});
    publishToTopic = jest.fn();
    connect() {
      if (!mockHoldConnect) return Promise.resolve();
      return new Promise<void>((resolve) => {
        this.releaseConnect = resolve;
      });
    }
  },
}));

import { WalletConnectV1Client } from '../client';

const KEY = 'a1b2c3d4'.repeat(8);
const config = (topic: string, bridge: string) => ({
  topic,
  version: '1',
  bridge,
  key: KEY,
});
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('v1 connect callers are mutually exclusive', () => {
  let client: WalletConnectV1Client;
  beforeEach(() => {
    mockSockets.length = 0;
    mockHoldConnect = false;
    client = new (
      WalletConnectV1Client as unknown as new () => WalletConnectV1Client
    )();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('restore connects on an idle client', async () => {
    expect(
      await client.connect(config('stored', 'https://restore'), {
        onlyIfIdle: true,
      })
    ).toBe(true);
    expect(mockSockets).toHaveLength(1);
  });

  it('restore is skipped, and replaces nothing, when a link already holds the client', async () => {
    await client.connect(config('link-a', 'https://link'));
    expect(
      await client.connect(config('stored', 'https://restore'), {
        onlyIfIdle: true,
      })
    ).toBe(false);
    expect(mockSockets).toHaveLength(1);
    expect(mockSockets[0].destroy).not.toHaveBeenCalled();
  });

  it('restore is skipped, without waiting, while a link connect is in flight', async () => {
    mockHoldConnect = true;
    const link = client.connect(config('link-a', 'https://link'));
    await tick();
    expect(
      await client.connect(config('stored', 'https://restore'), {
        onlyIfIdle: true,
      })
    ).toBe(false);
    expect(mockSockets).toHaveLength(1);
    mockSockets[0].releaseConnect();
    await link;
  });

  it('a link waits for a restore in flight, then replaces it and destroys its socket', async () => {
    mockHoldConnect = true;
    const restore = client.connect(config('stored', 'https://restore'), {
      onlyIfIdle: true,
    });
    await tick();
    const link = client.connect(config('link-a', 'https://link'));
    await tick();
    // The link has not touched the client while the restore is in flight.
    expect(mockSockets).toHaveLength(1);
    expect(mockSockets[0].destroy).not.toHaveBeenCalled();

    mockSockets[0].releaseConnect();
    await restore;
    await tick();
    expect(mockSockets).toHaveLength(2);
    expect(mockSockets[0].destroy).toHaveBeenCalledTimes(1);
    mockSockets[1].releaseConnect();
    await link;
  });

  it('always destroys the previous socket, including one awaiting approval', async () => {
    await client.connect(config('link-a', 'https://link-a'));
    await client.connect(config('link-b', 'https://link-b'));
    expect(mockSockets).toHaveLength(2);
    expect(mockSockets[0].destroy).toHaveBeenCalledTimes(1);
    expect(mockSockets[1].destroy).not.toHaveBeenCalled();
  });
});

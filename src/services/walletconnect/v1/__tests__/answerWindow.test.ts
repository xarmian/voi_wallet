// The window between a v1 item's close and the end of its answer, and what a
// replacing link may and may not touch in it.

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

let mockReleaseDelete: () => void = () => {};
jest.mock('../sessionCleanup', () => ({
  deleteV1Session: () =>
    new Promise<void>((resolve) => {
      mockReleaseDelete = resolve;
    }),
  deleteV1Sessions: async () => {},
}));

let mockReleaseDecrypt: (value: unknown) => void = () => {};
jest.mock('../protocol', () => ({
  ...jest.requireActual('../protocol'),
  parseEncryptedPayload: () => ({ data: 'x', hmac: 'y', iv: 'z' }),
  decryptRequest: () =>
    new Promise((resolve) => {
      mockReleaseDecrypt = resolve;
    }),
}));

let mockFailConnect = false;
const mockSockets: { destroy: jest.Mock }[] = [];
jest.mock('../websocket', () => ({
  WalletConnectV1WebSocket: class {
    destroy = jest.fn();
    constructor() {
      mockSockets.push(this as unknown as { destroy: jest.Mock });
    }
    onStatusChange() {}
    onError() {}
    onTopicMessageWithMeta() {}
    subscribeToTopic = jest.fn(async () => {});
    publishToTopic = jest.fn();
    connect() {
      return mockFailConnect
        ? Promise.reject(new Error('bridge unreachable'))
        : Promise.resolve();
    }
  },
}));

import { WalletConnectV1Client } from '../client';

const KEY = 'a1b2c3d4'.repeat(8);

const installSession = (
  client: WalletConnectV1Client,
  topic: string,
  peerId: string
) => {
  const publishToTopic = jest.fn();
  const destroy = jest.fn();
  const internals = client as unknown as Record<string, unknown>;
  internals.config = {
    topic,
    version: '1',
    bridge: 'https://bridge',
    key: KEY,
  };
  internals.socket = { publishToTopic, destroy };
  internals.sessionData = {
    handshakeTopic: topic,
    peerId,
    connected: true,
    accounts: [],
  };
  return { publishToTopic, destroy };
};

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('v1 answer window', () => {
  let client: WalletConnectV1Client;
  beforeEach(() => {
    mockSockets.length = 0;
    mockFailConnect = false;
    client = new (
      WalletConnectV1Client as unknown as new () => WalletConnectV1Client
    )();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('is answering from the start of an approval until its publish, and not before or after', async () => {
    installSession(client, 'topic-s1', 'peer-s1');
    expect(client.isAnswering()).toBe(false);
    const answer = client.approveRequest(7, ['signed'], 'topic-s1');
    expect(client.isAnswering()).toBe(true);
    await answer;
    expect(client.isAnswering()).toBe(false);
  });

  it('is answering through a refused answer too', async () => {
    installSession(client, 'topic-s2', 'peer-s2');
    const answer = client.rejectRequest(7, 'expired', 'topic-s1');
    expect(client.isAnswering()).toBe(true);
    await expect(answer).rejects.toThrow();
    expect(client.isAnswering()).toBe(false);
  });

  it('is answering for the whole of a disconnect, including its storage delete', async () => {
    installSession(client, 'topic-s1', 'peer-s1');
    const done = client.disconnect();
    await tick();
    expect(client.isAnswering()).toBe(true);
    mockReleaseDelete();
    await done;
    expect(client.isAnswering()).toBe(false);
  });

  it('disconnect leaves a replacing connection alone when it started during the storage delete', async () => {
    installSession(client, 'topic-s1', 'peer-s1');
    const done = client.disconnect();
    await tick();
    const next = installSession(client, 'topic-s2', 'peer-s2');
    mockReleaseDelete();
    await done;
    const internals = client as unknown as {
      config: { topic: string } | null;
      sessionData: { peerId: string } | null;
    };
    expect(internals.config?.topic).toBe('topic-s2');
    expect(internals.sessionData?.peerId).toBe('peer-s2');
    expect(next.destroy).not.toHaveBeenCalled();
  });

  it('a link that fails to connect releases the client, so a later restore connects', async () => {
    mockFailConnect = true;
    await expect(
      client.connect({
        topic: 'link-a',
        version: '1',
        bridge: 'https://link',
        key: KEY,
      })
    ).rejects.toThrow('bridge unreachable');
    expect(mockSockets[0].destroy).toHaveBeenCalledTimes(1);

    mockFailConnect = false;
    expect(
      await client.connect(
        { topic: 'stored', version: '1', bridge: 'https://restore', key: KEY },
        { onlyIfIdle: true }
      )
    ).toBe(true);
  });

  it('a message still decrypting when a link replaces the session is dropped, not answered to the new peer', async () => {
    const old = installSession(client, 'topic-s1', 'peer-s1');
    const handling = (
      client as unknown as { handleMessage: (p: string) => Promise<void> }
    ).handleMessage('payload');
    await tick();
    const next = installSession(client, 'topic-s2', 'peer-s2');
    mockReleaseDecrypt({ id: 9, method: 'unknown_method', params: [] });
    await handling;
    expect(old.publishToTopic).not.toHaveBeenCalled();
    expect(next.publishToTopic).not.toHaveBeenCalled();
  });

  it('a message that decrypts on an unchanged session is still handled', async () => {
    const only = installSession(client, 'topic-s1', 'peer-s1');
    const handling = (
      client as unknown as { handleMessage: (p: string) => Promise<void> }
    ).handleMessage('payload');
    await tick();
    mockReleaseDecrypt({ id: 9, method: 'unknown_method', params: [] });
    await handling;
    expect(only.publishToTopic).toHaveBeenCalledTimes(1);
  });
});

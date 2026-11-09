// A proposal is closed in the coordinator before the client answers it, so a
// pairing link may connect while the answer is still being built. The answer
// must then be refused, never published to, or deleting, the replacing session.

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

let mockReleaseAccounts: () => void = () => {};
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: () =>
      new Promise((resolve) => {
        mockReleaseAccounts = () => resolve([{ address: 'ADDR' }]);
      }),
  },
}));
jest.mock('../../utils', () => ({
  resolveProposalEligibility: async () => [
    { account: { address: 'ADDR' }, eligibleChains: [416001], errorChains: [] },
  ],
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
  internals.socket = {
    publishToTopic,
    destroy,
    onTopicMessageWithMeta: jest.fn(),
    subscribeToTopic: jest.fn(async () => {}),
  };
  internals.clientId = `client-${peerId}`;
  internals.handshakeId = 1;
  internals.sessionData = {
    handshakeTopic: topic,
    peerId,
    chainId: 416001,
    connected: false,
    accounts: [],
  };
  return { publishToTopic, destroy };
};

describe('v1 session answers across a replacing link', () => {
  let client: WalletConnectV1Client;
  beforeEach(() => {
    client = new (
      WalletConnectV1Client as unknown as new () => WalletConnectV1Client
    )();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('rejectSession refuses, publishes nothing and deletes nothing when the session was replaced', async () => {
    const old = installSession(client, 'topic-s1', 'peer-s1');
    const answer = client.rejectSession();
    const next = installSession(client, 'topic-s2', 'peer-s2');
    await expect(answer).rejects.toThrow('Session was replaced');
    expect(old.publishToTopic).not.toHaveBeenCalled();
    expect(next.publishToTopic).not.toHaveBeenCalled();
    expect(next.destroy).not.toHaveBeenCalled();
    expect(
      (client as unknown as { config: { topic: string } }).config.topic
    ).toBe('topic-s2');
  });

  it('rejectSession on an unchanged session publishes to its handshake topic and disconnects it', async () => {
    const only = installSession(client, 'topic-s1', 'peer-s1');
    await client.rejectSession();
    expect(only.publishToTopic).toHaveBeenCalledTimes(1);
    expect(only.publishToTopic.mock.calls[0][0]).toBe('topic-s1');
    expect(only.destroy).toHaveBeenCalledTimes(1);
  });

  it('approveSession refuses, publishes nothing and keeps the replacing session when it was replaced', async () => {
    const old = installSession(client, 'topic-s1', 'peer-s1');
    const answer = client.approveSession(['ADDR']);
    const next = installSession(client, 'topic-s2', 'peer-s2');
    await Promise.resolve();
    mockReleaseAccounts();
    await expect(answer).rejects.toThrow('Session was replaced');
    expect(old.publishToTopic).not.toHaveBeenCalled();
    expect(next.publishToTopic).not.toHaveBeenCalled();
    const data = (client as unknown as { sessionData: { peerId: string } })
      .sessionData;
    expect(data.peerId).toBe('peer-s2');
  });

  it('approveSession on an unchanged session publishes to its peer', async () => {
    const only = installSession(client, 'topic-s1', 'peer-s1');
    const answer = client.approveSession(['ADDR']);
    await Promise.resolve();
    mockReleaseAccounts();
    await answer;
    expect(only.publishToTopic).toHaveBeenCalledTimes(1);
    expect(only.publishToTopic.mock.calls[0][0]).toBe('peer-s1');
  });
});

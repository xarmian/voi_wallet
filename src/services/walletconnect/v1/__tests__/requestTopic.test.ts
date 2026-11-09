// The v1 client is a singleton: a new connection replaces its session, and an
// answer is encrypted with the current key and published to the current peer.
// An answer that names the topic its request arrived on must be refused once
// that is no longer the current session, so it can never reach a peer that did
// not make the request.

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

import { WalletConnectV1Client } from '../client';

const KEY = 'a1b2c3d4'.repeat(8);

const installSession = (
  client: WalletConnectV1Client,
  topic: string,
  peerId: string
) => {
  const publishToTopic = jest.fn();
  const internals = client as unknown as Record<string, unknown>;
  internals.config = {
    topic,
    version: '1',
    bridge: 'https://bridge',
    key: KEY,
  };
  internals.socket = { publishToTopic, destroy: jest.fn() };
  internals.sessionData = {
    handshakeTopic: topic,
    peerId,
    connected: true,
    accounts: [],
  };
  return publishToTopic;
};

describe('v1 answers name the session their request arrived on', () => {
  let client: WalletConnectV1Client;
  beforeEach(() => {
    client = new (
      WalletConnectV1Client as unknown as new () => WalletConnectV1Client
    )();
  });

  it('approves a request of the current session to its peer', async () => {
    const publish = installSession(client, 'topic-s1', 'peer-s1');
    await client.approveRequest(7, ['signed'], 'topic-s1');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe('peer-s1');
  });

  it('refuses to approve a request of a replaced session and publishes nothing', async () => {
    const publish = installSession(client, 'topic-s2', 'peer-s2');
    await expect(
      client.approveRequest(7, ['signed'], 'topic-s1')
    ).rejects.toThrow('Request belongs to a replaced session');
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a request of the current session to its peer', async () => {
    const publish = installSession(client, 'topic-s1', 'peer-s1');
    await client.rejectRequest(7, 'expired', 'topic-s1');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe('peer-s1');
  });

  it('refuses to answer a request of a replaced session and publishes nothing', async () => {
    const publish = installSession(client, 'topic-s2', 'peer-s2');
    await expect(
      client.rejectRequest(7, 'expired', 'topic-s1')
    ).rejects.toThrow('Request belongs to a replaced session');
    expect(publish).not.toHaveBeenCalled();
  });

  it('matches the pairing topic before a session exists', async () => {
    const publish = installSession(client, 'topic-s1', 'peer-s1');
    (client as unknown as Record<string, unknown>).sessionData = null;
    await client.rejectRequest(7, 'expired', 'topic-s1');
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(client.rejectRequest(8, 'expired', 'other')).rejects.toThrow(
      'Request belongs to a replaced session'
    );
  });

  it('keeps answering without a topic for the client’s own internal rejections', async () => {
    const publish = installSession(client, 'topic-s1', 'peer-s1');
    await client.rejectRequest(7, 'Unsupported method');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes an approval to the session it was checked against when a link replaces the session during the encrypt', async () => {
    const oldPublish = installSession(client, 'topic-s1', 'peer-s1');
    const answer = client.approveRequest(7, ['signed'], 'topic-s1');
    // Synchronously, before the encrypt resolves: a link replaces the session.
    const newPublish = installSession(client, 'topic-s2', 'peer-s2');
    await answer;
    expect(oldPublish).toHaveBeenCalledTimes(1);
    expect(oldPublish.mock.calls[0][0]).toBe('peer-s1');
    expect(newPublish).not.toHaveBeenCalled();
  });

  it('publishes a rejection to the session it was checked against when a link replaces the session during the encrypt', async () => {
    const oldPublish = installSession(client, 'topic-s1', 'peer-s1');
    const answer = client.rejectRequest(7, 'expired', 'topic-s1');
    const newPublish = installSession(client, 'topic-s2', 'peer-s2');
    await answer;
    expect(oldPublish).toHaveBeenCalledTimes(1);
    expect(oldPublish.mock.calls[0][0]).toBe('peer-s1');
    expect(newPublish).not.toHaveBeenCalled();
  });
});

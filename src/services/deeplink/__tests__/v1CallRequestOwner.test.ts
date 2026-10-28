/**
 * Single owner for WalletConnect v1 `call_request` (TASK-257).
 *
 * WalletConnectV1Client is a process singleton. Every v1 pairing used to add
 * another permanent `call_request` listener to it (and a restored session
 * added one more), so after a re-pair one signing request surfaced as two or
 * more identical groups. DeepLinkService.attachV1CallRequests() now owns the
 * one listener. These specs drive the REAL DeepLinkService and the REAL
 * TransactionRequestQueue dedupe against a real EventEmitter standing in for
 * the v1 client. No key material: the transactions are opaque placeholders.
 */

import { EventEmitter } from 'events';
import type { NavigationContainerRef } from '@react-navigation/native';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@react-navigation/native', () => ({
  StackActions: { replace: jest.fn() },
}));
jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: { getInstance: () => ({ pair: jest.fn() }) },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: { getInstance: jest.fn() },
}));
jest.mock('@/services/notifications', () => ({
  notificationService: { setNotificationTapHandler: jest.fn() },
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: null }) },
}));
jest.mock('@/store/networkStore', () => ({
  useNetworkStore: { getState: () => ({ currentNetwork: 'voi-mainnet' }) },
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: () => ({ name: 'Voi' }),
}));

import { DeepLinkService } from '../index';
import {
  QueueFullError,
  TransactionRequestQueue,
} from '@/services/walletconnect/TransactionRequestQueue';

class FakeV1Client extends EventEmitter {
  constructor(private handshakeTopic: string) {
    super();
  }
  getSessionData() {
    return { handshakeTopic: this.handshakeTopic, chainId: 416101 };
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const makeNav = () => {
  const ref = {
    isReady: jest.fn(() => true),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    getCurrentRoute: jest.fn((): { name: string } | undefined => undefined),
    addListener: jest.fn(() => () => {}),
  };
  return ref;
};

const callRequest = (id: number) => ({
  id,
  method: 'algo_signTxn',
  params: [{ txn: 'opaque' }],
});

describe('DeepLinkService v1 call_request owner (TASK-257)', () => {
  let service: DeepLinkService;
  let nav: ReturnType<typeof makeNav>;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    service = new DeepLinkService();
    nav = makeNav();
    service.setNavigationRef(nav as unknown as NavigationContainerRef<any>);
  });

  afterEach(async () => {
    TransactionRequestQueue.setDroppedRequestHandler(null);
    service.cleanup();
    await TransactionRequestQueue.clear();
    jest.restoreAllMocks();
  });

  it('re-pairing (restore, then a new pairing) keeps ONE listener: a request navigates once', async () => {
    const client = new FakeV1Client('handshake-1');

    // Session restore at boot, then the user re-pairs via a deep link.
    service.attachV1CallRequests(client as any, 'pair-topic-1');
    service.attachV1CallRequests(client as any, 'pair-topic-2');
    expect(client.listenerCount('call_request')).toBe(1);

    client.emit('call_request', callRequest(1001));
    await flush();

    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledWith(
      'WalletConnectTransactionRequest',
      {
        requestEvent: {
          id: 1001,
          topic: 'handshake-1',
          params: {
            request: {
              method: 'algo_signTxn',
              params: [[{ txn: 'opaque' }]],
            },
            chainId: 416101,
          },
        },
        version: 1,
      }
    );
  });

  it('a repeated call_request for the request on screen is not enqueued again', async () => {
    const client = new FakeV1Client('handshake-2');
    service.attachV1CallRequests(client as any, 'pair-topic');

    client.emit('call_request', callRequest(2001));
    await flush();
    expect(nav.navigate).toHaveBeenCalledTimes(1);

    nav.getCurrentRoute.mockReturnValue({
      name: 'WalletConnectTransactionRequest',
    });
    client.emit('call_request', callRequest(2001));
    await flush();
    expect(await TransactionRequestQueue.size()).toBe(0);

    // A genuinely new request while on screen is queued as v1.
    client.emit('call_request', callRequest(2002));
    await flush();
    const queued = await TransactionRequestQueue.getAll();
    expect(queued.map((r) => [r.id, r.topic, r.version])).toEqual([
      [2002, 'handshake-2', 1],
    ]);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
  });

  it('a failed delivery releases the claim: a redelivery of the request shows', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeV1Client('handshake-3');
    service.attachV1CallRequests(client as any, 'pair-topic');
    nav.navigate.mockImplementationOnce(() => {
      throw new Error('navigator gone');
    });

    client.emit('call_request', callRequest(3001));
    await flush();
    client.emit('call_request', callRequest(3001)); // relay redelivery
    await flush();
    expect(nav.navigate).toHaveBeenCalledTimes(2);

    // That one was shown: a further repeat is a duplicate.
    client.emit('call_request', callRequest(3001));
    await flush();
    expect(nav.navigate).toHaveBeenCalledTimes(2);
  });

  it('a request shown directly is not shown again from the persisted queue', async () => {
    const client = new FakeV1Client('handshake-4');
    service.attachV1CallRequests(client as any, 'pair-topic');
    // Persisted by a previous session, then redelivered by the relay.
    await TransactionRequestQueue.enqueue({
      id: 4001,
      topic: 'handshake-4',
      params: { request: { method: 'algo_signTxn', params: [] }, chainId: 1 },
      version: 1,
    });

    client.emit('call_request', callRequest(4001));
    await flush();
    expect(nav.navigate).toHaveBeenCalledTimes(1);

    // The screen's "next request" step finds nothing left to show.
    const show = jest.fn();
    expect((await TransactionRequestQueue.takeNext(show)).request).toBeNull();
    expect(show).not.toHaveBeenCalled();
    expect(await TransactionRequestQueue.size()).toBe(0);
  });

  describe('a v1 request the queue cannot take (TASK-394)', () => {
    const onScreen = () =>
      nav.getCurrentRoute.mockReturnValue({
        name: 'WalletConnectTransactionRequest',
      });

    it("queue full: reported 'full' as v1 and marked displayed, not released", async () => {
      const handler = jest.fn();
      TransactionRequestQueue.setDroppedRequestHandler(handler);
      const releaseClaim = jest.spyOn(TransactionRequestQueue, 'releaseClaim');
      const client = new FakeV1Client('handshake-5');
      service.attachV1CallRequests(client as any, 'pair-topic');
      onScreen();
      jest
        .spyOn(TransactionRequestQueue, 'enqueue')
        .mockRejectedValueOnce(new QueueFullError());

      client.emit('call_request', callRequest(5001));
      await flush();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        [
          {
            id: 5001,
            topic: 'handshake-5',
            params: {
              request: {
                method: 'algo_signTxn',
                params: [[{ txn: 'opaque' }]],
              },
              chainId: 416101,
            },
            timestamp: expect.any(Number),
            version: 1,
          },
        ],
        'full'
      );
      expect(releaseClaim).not.toHaveBeenCalled();
      expect(TransactionRequestQueue.markDisplayed(5001, 'handshake-5')).toBe(
        false
      );

      // A relay redelivery of the answered request is not queued again.
      client.emit('call_request', callRequest(5001));
      await flush();
      expect(await TransactionRequestQueue.size()).toBe(0);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('any other enqueue failure still releases the claim', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const handler = jest.fn();
      TransactionRequestQueue.setDroppedRequestHandler(handler);
      const client = new FakeV1Client('handshake-6');
      service.attachV1CallRequests(client as any, 'pair-topic');
      onScreen();
      jest
        .spyOn(TransactionRequestQueue, 'enqueue')
        .mockRejectedValueOnce(new Error('storage unavailable'));

      client.emit('call_request', callRequest(6001));
      await flush();
      expect(handler).not.toHaveBeenCalled();

      // Released: the redelivery is queued.
      client.emit('call_request', callRequest(6001));
      await flush();
      expect((await TransactionRequestQueue.getAll()).map((r) => r.id)).toEqual(
        [6001]
      );
    });
  });
});

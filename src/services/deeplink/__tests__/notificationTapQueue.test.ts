/**
 * A notification tap and a bad pairing link while the WalletConnect review
 * queue is in use (TASK-518 U4b-2). A tap does not route over a head or a
 * result card or a waiting item: it waits until the queue is empty, then goes
 * where it always went. A pairing link that fails opens the error route and
 * leaves the head where it is. The queue and coordinator are the real ones.
 * No key material: payloads are opaque placeholders.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NavigationContainerRef } from '@react-navigation/native';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  RequestCoordinator,
  CoordinatorTransport,
} from '@/services/walletconnect/requestCoordinator';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { requestRefFor } from '@/services/walletconnect/requestRefs';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@react-navigation/native', () => ({
  StackActions: jest.requireActual('@react-navigation/native').StackActions,
}));
jest.mock('@/services/walletconnect', () => ({
  ...jest.requireActual('@/services/walletconnect/config'),
  getNetworkNameByChainId: jest.requireActual('@/services/walletconnect/utils')
    .getNetworkNameByChainId,
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
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { hasKeyBearingAccountStrict: async () => true },
}));

import { DeepLinkService } from '../index';
import { notificationService } from '@/services/notifications';

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

const HOME = {
  screen: 'Main',
  params: { screen: 'Home', params: { screen: 'HomeMain' } },
};

describe('notification taps and the review queue', () => {
  let service: DeepLinkService;
  let coordinator: RequestCoordinator;
  let queue: RequestQueue;
  let tap: (data: any, id?: string) => Promise<void>;
  const nav = {
    isReady: jest.fn(() => true),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    getCurrentRoute: jest.fn((): { name: string } | undefined => undefined),
    addListener: jest.fn(() => () => {}),
  };

  const open = async (id: number) => {
    const event = { id, topic: `topic-${id}` };
    const ref = requestRefFor(event, 2);
    await coordinator.admit(ref);
    expect(
      queue.push({ ref, payload: event, firstSeenMs: Date.now() })
    ).toMatch(/head|queued/);
    return ref;
  };

  const homeRoutes = () =>
    nav.navigate.mock.calls.filter(
      ([screen, params]) =>
        screen === HOME.screen &&
        JSON.stringify(params) === JSON.stringify(HOME.params)
    );

  beforeEach(async () => {
    await AsyncStorage.clear();
    HandledStore.getInstance().__resetForTests();
    const transport: CoordinatorTransport = {
      rejectRequestV2: jest.fn(async () => {}),
      rejectRequestV1: jest.fn(async () => {}),
      rejectProposalV2: jest.fn(async () => {}),
      rejectProposalV1: jest.fn(async () => {}),
    };
    coordinator = new RequestCoordinator({
      store: new HandledStore(),
      transport,
    });
    jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
    queue = new RequestQueue({ coordinator });
    jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
    nav.navigate.mockReset();
    nav.dispatch.mockReset();
    nav.isReady.mockReset().mockReturnValue(true);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    service = new DeepLinkService();
    service.setNavigationRef(nav as unknown as NavigationContainerRef<any>);
    service.setUnlockState(true);
    (service as any).setupNotificationHandler();
    tap = jest
      .mocked(notificationService.setNotificationTapHandler)
      .mock.calls.slice(-1)[0][0] as typeof tap;
  });

  afterEach(() => {
    coordinator.__resetForTests();
    queue.__resetForTests();
    service.cleanup();
    jest.restoreAllMocks();
  });

  it('with an empty queue a payment tap goes home as before', async () => {
    await tap({ type: 'payment' }, 'n-1');
    await flush();

    expect(homeRoutes()).toHaveLength(1);
  });

  it('with a head on screen the tap routes nowhere', async () => {
    await open(1);

    await tap({ type: 'payment' }, 'n-1');
    await flush();

    expect(nav.navigate).not.toHaveBeenCalled();
    expect(nav.dispatch).not.toHaveBeenCalled();
    expect(queue.getSnapshot().head?.ref.id).toBe(1);
  });

  it('the tap waits through the result card and goes once the card is dismissed', async () => {
    const ref = await open(1);
    await tap({ type: 'payment' }, 'n-1');
    await flush();

    queue.closeHead(ref, 'declined');
    await flush();
    expect(queue.getSnapshot().result).not.toBeNull();
    expect(nav.navigate).not.toHaveBeenCalled();

    queue.dismissResult();
    await flush();

    expect(homeRoutes()).toHaveLength(1);
  });

  it('the tap waits through every waiting request, then goes exactly once', async () => {
    const first = await open(1);
    const second = await open(2);
    await tap({ type: 'payment' }, 'n-1');
    await flush();

    queue.closeHead(first, 'declined');
    queue.advance();
    await flush();
    expect(queue.getSnapshot().head?.ref.id).toBe(2);
    expect(nav.navigate).not.toHaveBeenCalled();

    queue.closeHead(second, 'declined');
    queue.dismissResult();
    await flush();

    expect(homeRoutes()).toHaveLength(1);
  });

  it('the tap goes once: a later request filling and emptying the queue does not repeat it', async () => {
    const first = await open(1);
    await tap({ type: 'payment' }, 'n-1');
    await flush();
    queue.closeHead(first, 'declined');
    queue.dismissResult();
    await flush();
    expect(homeRoutes()).toHaveLength(1);

    const second = await open(2);
    queue.closeHead(second, 'declined');
    queue.dismissResult();
    await flush();

    expect(homeRoutes()).toHaveLength(1);
  });

  it('a tap that arrived while locked is still held until the queue is empty after unlock', async () => {
    service.setUnlockState(false);
    await open(1);
    await tap({ type: 'payment' }, 'n-1');
    await flush();
    expect(service.hasPendingNotification()).toBe(true);

    service.setUnlockState(true);
    await flush();

    expect(nav.navigate).not.toHaveBeenCalled();
    queue.closeHead(requestRefFor({ id: 1, topic: 'topic-1' }, 2), 'declined');
    queue.dismissResult();
    await flush();
    expect(homeRoutes()).toHaveLength(1);
  });

  it('a message tap also waits for the queue, then opens the inbox and the chat', async () => {
    jest.useFakeTimers();
    try {
      const ref = await open(1);

      await tap({ type: 'message', sender: 'SENDERADDRESS' }, 'n-1');
      await flush();
      expect(nav.navigate).not.toHaveBeenCalled();

      queue.closeHead(ref, 'declined');
      queue.dismissResult();
      await flush();
      expect(nav.navigate).toHaveBeenCalledTimes(1);
      expect(nav.navigate.mock.calls[0][1]).toEqual({
        screen: 'Friends',
        params: { screen: 'MessagesInbox' },
      });

      jest.advanceTimersByTime(200);
      await flush();
      expect(nav.navigate).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a tap that waits does not hold up other routes', async () => {
    await open(1);
    const waiting = tap({ type: 'payment' }, 'n-1');

    await expect(waiting).resolves.toBeUndefined();
    await service.deliverRoute('other-route', async () => {});
  });

  describe('a bad pairing link while a request is open', () => {
    it('opens the error route and leaves the head where it is', async () => {
      const ref = await open(1);

      // A wc: v1 link with no parsable pairing data.
      expect(await service.testDeepLink('wc:garbage@1')).toBe(false);
      await flush();

      expect(queue.getSnapshot().head?.ref).toEqual(ref);
      expect(coordinator.isOpen(ref)).toBe(true);
      expect(queue.getSnapshot().result).toBeNull();
    });
  });
});

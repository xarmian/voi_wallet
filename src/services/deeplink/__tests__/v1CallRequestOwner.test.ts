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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  RequestCoordinator,
  CoordinatorTransport,
} from '@/services/walletconnect/requestCoordinator';
import {
  requestRefFor,
  v1ProposalRefFor,
} from '@/services/walletconnect/requestRefs';
import { EventEmitter } from 'events';
import type { NavigationContainerRef } from '@react-navigation/native';

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
  MultiAccountWalletService: {
    getAllAccounts: async () => [
      {
        id: 'account',
        address: 'fixture-address',
        label: 'Fixture',
        type: 'standard',
      },
    ],
  },
}));
jest.mock('@/services/walletconnect/utils', () => ({
  ...jest.requireActual('@/services/walletconnect/utils'),
  resolveProposalEligibility: async (accounts: object[], chains: string[]) =>
    accounts.map((account) => ({
      account,
      eligibleChains: chains,
      errorChains: [],
    })),
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authState: { isLocked: false, isAuthenticated: true } }),
}));
jest.mock('@/hooks/useSecureScreen', () => ({
  useSecureScreen: jest.fn(),
  useAppSwitcherProtection: jest.fn(),
}));
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/walletconnect/AccountSelectionItem', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/walletconnect/LockedRequestGate', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/services/auth/reviewGrant', () => ({
  reviewGrant: {
    subscribe: () => () => {},
    isValid: () => true,
    leave: jest.fn(),
    revoke: jest.fn(),
  },
  walletConnectRequestKey: () => 'proposal-review',
}));

import { DeepLinkService, V1_BUSY_TOAST } from '../index';
import React from 'react';
import { Alert } from 'react-native';
import { act, render, fireEvent, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import SessionProposalScreen from '@/screens/walletconnect/SessionProposalScreen';
import {
  QueueFullError,
  TransactionRequestQueue,
} from '@/services/walletconnect/TransactionRequestQueue';

class FakeV1Client extends EventEmitter {
  constructor(private handshakeTopic: string) {
    super();
  }
  connect = jest.fn(async (_config: unknown) => {});
  approveSession = jest.fn(async (_accounts: string[]) => {});
  getSessionData() {
    return { handshakeTopic: this.handshakeTopic, chainId: 416101 };
  }
}

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
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

  let store: HandledStore;
  let coordinator: RequestCoordinator;
  let transport: jest.Mocked<CoordinatorTransport>;

  beforeEach(async () => {
    await AsyncStorage.clear();
    HandledStore.getInstance().__resetForTests();
    store = new HandledStore();
    transport = {
      rejectRequestV2: jest.fn<
        Promise<void>,
        Parameters<CoordinatorTransport['rejectRequestV2']>
      >(async () => {}),
      rejectRequestV1: jest.fn<
        Promise<void>,
        Parameters<CoordinatorTransport['rejectRequestV1']>
      >(async () => {}),
      rejectProposalV2: jest.fn<
        Promise<void>,
        Parameters<CoordinatorTransport['rejectProposalV2']>
      >(async () => {}),
      rejectProposalV1: jest.fn<
        Promise<void>,
        Parameters<CoordinatorTransport['rejectProposalV1']>
      >(async () => {}),
    };
    coordinator = new RequestCoordinator({ store, transport });
    jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
    jest.mocked(Toast.show).mockClear();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    service = new DeepLinkService();
    nav = makeNav();
    service.setNavigationRef(nav as unknown as NavigationContainerRef<any>);
  });

  afterEach(async () => {
    coordinator.__resetForTests();
    TransactionRequestQueue.setDroppedRequestHandler(null);
    service.cleanup();
    await TransactionRequestQueue.clear();
    jest.restoreAllMocks();
  });

  const link = (name: string) =>
    'wc:' +
    name +
    '@1?bridge=https%3A%2F%2Fbridge.example&key=' +
    'ab'.repeat(32);
  const installClient = () => {
    const client = new FakeV1Client('fixture');
    const { WalletConnectV1Client } = require('@/services/walletconnect/v1');
    WalletConnectV1Client.getInstance.mockReturnValue(client);
    return client;
  };

  it.each(['Reject', 'Connect'] as const)(
    'U8 refuses B while A is open, then A can %s and C connects',
    async (action) => {
      const client = installClient();
      expect(await service.testDeepLink(link('A'))).toBe(true);
      const sessionRequest = { id: 8101, chainId: 416001 };
      client.emit('session_request', sessionRequest);
      await flush();
      expect(nav.dispatch).toHaveBeenCalledTimes(1);
      const delivered = nav.dispatch.mock.calls[0][0];
      expect(delivered).toEqual({
        type: 'PUSH',
        payload: {
          name: 'WalletConnectSessionProposal',
          params: { version: 1, sessionRequest },
        },
      });
      const screenNavigation = {
        addListener: () => () => {},
        canGoBack: () => true,
        navigate: jest.fn(),
        dispatch: jest.fn(),
        getState: () => ({ routes: [{ key: 'connect-A' }] }),
      };
      const route = {
        key: 'connect-A',
        name: 'WalletConnectSessionProposal',
        params: delivered.payload.params,
      };
      const screen = await render(
        React.createElement(SessionProposalScreen, {
          navigation: screenNavigation as never,
          route: route as never,
        })
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
      );
      const admit = jest.spyOn(coordinator, 'admit');
      expect(await service.testDeepLink(link('B'))).toBe(false);
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'info',
        ...V1_BUSY_TOAST,
      });
      expect(V1_BUSY_TOAST).toEqual({
        text1: 'Connection in progress',
        text2: 'Finish or cancel the open connection, then try again.',
      });
      expect(nav.dispatch).toHaveBeenCalledTimes(1);
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(screenNavigation.dispatch).not.toHaveBeenCalled();
      expect(route.params).toEqual(delivered.payload.params);
      expect(coordinator.isOpen(v1ProposalRefFor(sessionRequest))).toBe(true);
      expect(admit).not.toHaveBeenCalled();
      Object.values(transport).forEach((fn) =>
        expect(fn).not.toHaveBeenCalled()
      );
      expect(client.approveSession).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByText(action));
      if (action === 'Reject') {
        expect(transport.rejectProposalV1).toHaveBeenCalledTimes(1);
        expect(client.approveSession).not.toHaveBeenCalled();
      } else {
        expect(client.approveSession).toHaveBeenCalledTimes(1);
        expect(client.approveSession).toHaveBeenCalledWith(['fixture-address']);
        expect(transport.rejectProposalV1).not.toHaveBeenCalled();
      }
      expect(coordinator.isOpen(v1ProposalRefFor(sessionRequest))).toBe(false);
      expect(await service.testDeepLink(link('C'))).toBe(true);
      expect(client.connect).toHaveBeenCalledTimes(2);
      await act(async () => screen.unmount());
    }
  );

  it('U8 refuses B during the pairing window before A connect resolves', async () => {
    const client = installClient();
    let finish!: () => void;
    client.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const first = service.testDeepLink(link('A'));
    expect(await service.testDeepLink(link('B'))).toBe(false);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('session_request')).toBe(1);
    expect(Toast.show).toHaveBeenCalledWith({ type: 'info', ...V1_BUSY_TOAST });
    expect(nav.dispatch).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
    finish();
    await first;
  });

  it.each(['error event', 'connect rejection'] as const)(
    'U8 permits retry after pairing %s',
    async (failure) => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const client = installClient();
      if (failure === 'connect rejection')
        client.connect.mockRejectedValueOnce(new Error('connection failed'));
      await service.testDeepLink(link('A'));
      if (failure === 'error event')
        client.emit('error', new Error('connection failed'));
      await flush();
      nav.navigate.mockClear();
      expect(await service.testDeepLink(link('C'))).toBe(true);
      expect(client.connect).toHaveBeenCalledTimes(2);
      expect(Toast.show).not.toHaveBeenCalled();
    }
  );

  it('U8 a pairing that never produces a proposal stops blocking new links after the wait', async () => {
    jest.useFakeTimers();
    try {
      const client = installClient();
      await service.testDeepLink(link('A'));
      expect(await service.testDeepLink(link('B'))).toBe(false);
      expect(client.connect).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(await service.testDeepLink(link('C'))).toBe(true);
      expect(client.connect).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
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
  it('DEFECT a handled v1 request gets the v1 answer without navigation', async () => {
    const client = new FakeV1Client('handshake-handled');
    service.attachV1CallRequests(
      client as unknown as Parameters<
        DeepLinkService['attachV1CallRequests']
      >[0],
      'pair-topic'
    );
    await store.markHandled(
      requestRefFor({ id: 51801, topic: 'handshake-handled' }, 1),
      'approved'
    );
    client.emit('call_request', callRequest(51801));
    await flush();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(transport.rejectRequestV1).toHaveBeenCalledWith(
      51801,
      'Request already handled.'
    );
  });

  it('DEFECT a v1 request not ready for navigation is released and redelivered once', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeV1Client('handshake-release');
    service.attachV1CallRequests(
      client as unknown as Parameters<
        DeepLinkService['attachV1CallRequests']
      >[0],
      'pair-topic'
    );
    // The queue observes readiness, then the callback observes it being lost.
    // All other checks use the real route queue and request-claim lifecycle.
    nav.isReady
      .mockReturnValueOnce(true) // deliver accepts the route
      .mockReturnValueOnce(true) // drain starts the callback
      .mockReturnValueOnce(false); // navigation is no longer ready
    const ref = requestRefFor({ id: 51802, topic: 'handshake-release' }, 1);
    const release = jest.spyOn(coordinator, 'release');
    const admit = jest.spyOn(coordinator, 'admit');
    client.emit('call_request', callRequest(51802));
    await flush();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(ref);
    expect(coordinator.isOpen(ref)).toBe(false);
    client.emit('call_request', callRequest(51802));
    await flush();
    expect(admit).toHaveBeenCalledTimes(2);
    expect(
      await Promise.all(admit.mock.results.map((result) => result.value))
    ).toEqual([
      expect.objectContaining({ action: 'show' }),
      expect.objectContaining({ action: 'show' }),
    ]);
    const first = await admit.mock.results[0].value;
    const second = await admit.mock.results[1].value;
    if (first.action !== 'show' || second.action !== 'show') {
      throw new Error('Expected both deliveries to be admitted');
    }
    expect(second.firstSeenMs).toBe(first.firstSeenMs);
    expect(coordinator.isOpen(ref)).toBe(true);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledWith(
      'WalletConnectTransactionRequest',
      expect.objectContaining({ version: 1 })
    );
    Object.values(transport).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
  it('DEFECT v1 expired admissions release every queue claim', async () => {
    const client = new FakeV1Client('handshake-expired');
    service.attachV1CallRequests(
      client as unknown as Parameters<
        DeepLinkService['attachV1CallRequests']
      >[0],
      'pair-topic'
    );
    const clock = jest.spyOn(Date, 'now');
    const started = Date.now();
    coordinator.__resetForTests();
    store = new HandledStore({ now: () => Date.now() });
    coordinator = new RequestCoordinator({
      store,
      transport,
      now: () => Date.now(),
    });
    jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
    for (let id = 5300; id < 5310; id++) {
      clock.mockReturnValue(started);
      await store.noteSeen(
        requestRefFor({ id, topic: 'handshake-expired' }, 1)
      );
      clock.mockReturnValue(started + 300_000);
      client.emit('call_request', callRequest(id));
      await flush();
      expect(TransactionRequestQueue.claim(id, 'handshake-expired')).toBe(true);
      TransactionRequestQueue.releaseClaim(id, 'handshake-expired');
    }
    expect(transport.rejectRequestV1).toHaveBeenCalledTimes(10);
  });
  it('DEFECT duplicate v1 delivery retries failed publish once', async () => {
    const client = new FakeV1Client('handshake-retry');
    service.attachV1CallRequests(
      client as unknown as Parameters<
        DeepLinkService['attachV1CallRequests']
      >[0],
      'pair-topic'
    );
    client.emit('call_request', callRequest(5311));
    await flush();
    transport.rejectRequestV1.mockRejectedValueOnce(
      new Error('publish failed')
    );
    await coordinator.settle(
      requestRefFor({ id: 5311, topic: 'handshake-retry' }, 1),
      'expired'
    );
    client.emit('call_request', callRequest(5311));
    await flush();
    expect(transport.rejectRequestV1).toHaveBeenCalledTimes(2);
    client.emit('call_request', callRequest(5311));
    await flush();
    expect(transport.rejectRequestV1).toHaveBeenCalledTimes(2);
  });
});

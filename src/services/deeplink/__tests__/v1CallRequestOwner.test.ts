/**
 * Entry-point behaviour of the v1 producers in DeepLinkService: the single
 * `call_request` listener, the pairing window that refuses a second v1 link,
 * and what the coordinator answers before anything reaches the review queue
 * (replay, expiry, publish retry, setup-incomplete refusal). What an admitted
 * arrival does once it reaches the queue is in v1Feed.test.ts. No key material:
 * the transactions are opaque placeholders.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  RequestCoordinator,
  CoordinatorTransport,
} from '@/services/walletconnect/requestCoordinator';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import {
  requestRefFor,
  v1ProposalRefFor,
} from '@/services/walletconnect/requestRefs';
import { markPinSetupPending } from '@/services/secure/pinSetupPending';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { setupIncompleteGuard } from '@/services/walletconnect/entryGuard';
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
    hasKeyBearingAccountStrict: async () => true,
  },
}));

import { DeepLinkService, V1_BUSY_TOAST } from '../index';
import { act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

class FakeV1Client extends EventEmitter {
  constructor(private handshakeTopic: string) {
    super();
  }
  answering = false;
  isAnswering() {
    return this.answering;
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
  let queue: RequestQueue;
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
    queue = new RequestQueue({ coordinator });
    jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
    jest.mocked(Toast.show).mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    service = new DeepLinkService();
    nav = makeNav();
    service.setNavigationRef(nav as unknown as NavigationContainerRef<any>);
  });

  afterEach(async () => {
    coordinator.__resetForTests();
    queue.__resetForTests();
    service.cleanup();
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
      'Request already handled.',
      'handshake-handled'
    );
  });

  it('DEFECT v1 expired admissions are each answered expired', async () => {
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
  describe('setup incomplete is refused at the entry point (S2)', () => {
    beforeEach(async () => {
      coordinator.setEntryGuard(setupIncompleteGuard);
      await markPinSetupPending();
      jest.spyOn(AccountSecureStorage, 'hasPinStrict').mockResolvedValue(false);
    });

    it('DEFECT a v1 request is answered setup-incomplete without a route or a queue entry', async () => {
      const client = new FakeV1Client('handshake-s2');
      service.attachV1CallRequests(
        client as unknown as Parameters<
          DeepLinkService['attachV1CallRequests']
        >[0],
        'pair-topic'
      );
      client.emit('call_request', callRequest(53101));
      await flush();
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(nav.dispatch).not.toHaveBeenCalled();
      expect(transport.rejectRequestV1).toHaveBeenCalledTimes(1);
      expect(transport.rejectRequestV1).toHaveBeenCalledWith(
        53101,
        'Wallet setup incomplete.',
        'handshake-s2'
      );
      expect(queue.getSnapshot().head).toBeNull();
    });

    it('DEFECT a v1 proposal is answered setup-incomplete without a route, and does not block the next link', async () => {
      const client = installClient();
      expect(await service.testDeepLink(link('A'))).toBe(true);
      const sessionRequest = { id: 53102, chainId: 416001 };
      client.emit('session_request', sessionRequest);
      await flush();
      expect(nav.dispatch).not.toHaveBeenCalled();
      expect(nav.navigate).not.toHaveBeenCalled();
      expect(transport.rejectProposalV1).toHaveBeenCalledTimes(1);
      expect(coordinator.hasOpenV1Item()).toBe(false);
      expect(coordinator.isOpen(v1ProposalRefFor(sessionRequest))).toBe(false);
      expect(await service.testDeepLink(link('B'))).toBe(true);
      expect(Toast.show).not.toHaveBeenCalledWith({
        type: 'info',
        ...V1_BUSY_TOAST,
      });
    });
  });
});

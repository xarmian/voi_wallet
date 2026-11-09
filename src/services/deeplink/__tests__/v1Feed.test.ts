/**
 * The v1 producers in DeepLinkService feed the WalletConnect review queue
 * (TASK-518 U4b-2). A v1 call_request and a v1 session_request are admitted by
 * the coordinator and then pushed to RequestQueue through feedQueue; nothing
 * is navigated or dispatched, so the host draws the review. The coordinator,
 * queue and handled store are the real ones; the v1 client is an EventEmitter.
 * No key material: the transactions are opaque placeholders.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { EventEmitter } from 'events';
import type { NavigationContainerRef } from '@react-navigation/native';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  RequestCoordinator,
  CoordinatorTransport,
} from '@/services/walletconnect/requestCoordinator';
import {
  MAX_WAITING,
  RequestQueue,
} from '@/services/walletconnect/requestQueue';
import {
  requestRefFor,
  v1ProposalRefFor,
} from '@/services/walletconnect/requestRefs';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@react-navigation/native', () => ({
  StackActions: jest.requireActual('@react-navigation/native').StackActions,
}));
const mockSessions: any[] = [];
jest.mock('@/services/walletconnect', () => ({
  ...jest.requireActual('@/services/walletconnect/config'),
  getNetworkNameByChainId: jest.requireActual('@/services/walletconnect/utils')
    .getNetworkNameByChainId,
  WalletConnectService: {
    getInstance: () => ({
      pair: jest.fn(),
      getActiveSessions: () => mockSessions,
    }),
  },
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
  getSessionData() {
    return { handshakeTopic: this.handshakeTopic, chainId: 416101 };
  }
}

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

const makeNav = () => ({
  isReady: jest.fn(() => true),
  navigate: jest.fn(),
  dispatch: jest.fn(),
  getCurrentRoute: jest.fn((): { name: string } | undefined => undefined),
  addListener: jest.fn(() => () => {}),
});

const callRequest = (id: number) => ({
  id,
  method: 'algo_signTxn',
  params: [{ txn: 'opaque' }],
});

const sessionRequest = (id: number) => ({
  id,
  chainId: 416001,
  peerMeta: {
    name: 'Example dApp',
    url: 'https://dapp.example/app',
    icons: ['https://dapp.example/icon.png'],
  },
});

describe('v1 producers feed the review queue', () => {
  let service: DeepLinkService;
  let nav: ReturnType<typeof makeNav>;
  let coordinator: RequestCoordinator;
  let queue: RequestQueue;
  let transport: jest.Mocked<CoordinatorTransport>;
  let client: FakeV1Client;

  const link = (name: string) =>
    'wc:' +
    name +
    '@1?bridge=https%3A%2F%2Fbridge.example&key=' +
    'ab'.repeat(32);

  const noRouteWasUsed = () => {
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(nav.dispatch).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    mockSessions.length = 0;
    await AsyncStorage.clear();
    HandledStore.getInstance().__resetForTests();
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
    coordinator = new RequestCoordinator({
      store: new HandledStore(),
      transport,
    });
    jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
    queue = new RequestQueue({ coordinator });
    jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
    jest.mocked(Toast.show).mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    service = new DeepLinkService();
    nav = makeNav();
    service.setNavigationRef(nav as unknown as NavigationContainerRef<any>);
    client = new FakeV1Client('handshake-1');
    const { WalletConnectV1Client } = require('@/services/walletconnect/v1');
    WalletConnectV1Client.getInstance.mockReturnValue(client);
  });

  afterEach(() => {
    coordinator.__resetForTests();
    queue.__resetForTests();
    service.cleanup();
    jest.restoreAllMocks();
  });

  describe('P3: a v1 call_request', () => {
    const attach = () => service.attachV1CallRequests(client as any, 'pair');

    it('the host head appears for the admitted v1 ref and no route is used', async () => {
      attach();

      client.emit('call_request', callRequest(1));
      await flush();

      const head = queue.getSnapshot().head;
      expect(head?.ref).toEqual(
        requestRefFor({ id: 1, topic: 'handshake-1' }, 1)
      );
      expect(head?.kind).toBe('request');
      expect(head?.payload).toEqual({
        id: 1,
        topic: 'handshake-1',
        params: {
          request: { method: 'algo_signTxn', params: [[{ txn: 'opaque' }]] },
          chainId: 416101,
        },
      });
      noRouteWasUsed();
    });

    it('a second request waits behind the first in arrival order', async () => {
      attach();

      client.emit('call_request', callRequest(1));
      client.emit('call_request', callRequest(2));
      await flush();

      expect(queue.getSnapshot().head?.ref.id).toBe(1);
      expect(queue.getSnapshot().waiting.map((w) => w.ref.id)).toEqual([2]);
      noRouteWasUsed();
    });

    it('carries the dApp from the v1 session and the chain as text', async () => {
      attach();
      mockSessions.push({
        topic: 'handshake-1',
        peerMetadata: {
          name: 'Example dApp',
          url: 'https://dapp.example/app',
          icons: ['https://dapp.example/icon.png'],
          description: '',
        },
      });

      client.emit('call_request', callRequest(1));
      await flush();

      const head = queue.getSnapshot().head;
      expect(head?.dapp).toEqual({
        name: 'Example dApp',
        url: 'https://dapp.example/app',
        icon: 'https://dapp.example/icon.png',
      });
      expect(head?.network).toBe('416101');
      expect(head?.firstSeenMs).toBe(
        coordinator.describe(requestRefFor({ id: 1, topic: 'handshake-1' }, 1))
          ?.firstSeenMs
      );
    });

    it('a request with no known session still queues', async () => {
      attach();

      client.emit('call_request', callRequest(1));
      await flush();

      expect(queue.getSnapshot().head?.ref.id).toBe(1);
      expect(queue.getSnapshot().head?.dapp).toBeUndefined();
    });

    it('the same request emitted twice is queued once and answered never', async () => {
      attach();

      client.emit('call_request', callRequest(1));
      await flush();
      client.emit('call_request', callRequest(1));
      await flush();

      expect(queue.getSnapshot().head?.ref.id).toBe(1);
      expect(queue.getSnapshot().waiting).toHaveLength(0);
      expect(transport.rejectRequestV1).not.toHaveBeenCalled();
    });

    it('a request admitted as a duplicate of an open ref is not pushed', async () => {
      attach();
      const ref = requestRefFor({ id: 1, topic: 'handshake-1' }, 1);
      await coordinator.admit(ref);
      jest
        .spyOn(coordinator, 'admit')
        .mockResolvedValue({ action: 'suppressed', reason: 'duplicate' });

      client.emit('call_request', callRequest(1));
      await flush();

      expect(coordinator.isOpen(ref)).toBe(true);
      expect(queue.getSnapshot().head).toBeNull();
    });

    it('a ref closed between admit and push is neither queued nor answered twice', async () => {
      attach();
      const ref = requestRefFor({ id: 1, topic: 'handshake-1' }, 1);
      const realAdmit = coordinator.admit.bind(coordinator);
      jest.spyOn(coordinator, 'admit').mockImplementation(async (...args) => {
        const admission = await realAdmit(...args);
        await coordinator.settle(ref, 'expired');
        return admission;
      });

      client.emit('call_request', callRequest(1));
      await flush();

      expect(queue.getSnapshot().head).toBeNull();
      expect(transport.rejectRequestV1).toHaveBeenCalledTimes(1);
    });

    it('past the waiting limit the dApp is answered busy once and the queue is unchanged', async () => {
      attach();
      for (let id = 1; id <= 1 + MAX_WAITING; id++) {
        client.emit('call_request', callRequest(id));
        await flush();
      }
      expect(queue.getSnapshot().waiting).toHaveLength(MAX_WAITING);
      expect(transport.rejectRequestV1).not.toHaveBeenCalled();

      client.emit('call_request', callRequest(100));
      await flush();

      expect(queue.getSnapshot().waiting).toHaveLength(MAX_WAITING);
      expect(transport.rejectRequestV1).toHaveBeenCalledTimes(1);
      expect(transport.rejectRequestV1.mock.calls[0][0]).toBe(100);
    });

    it('arrives before the container is ready and is still queued', async () => {
      attach();
      nav.isReady.mockReturnValue(false);

      client.emit('call_request', callRequest(1));
      await flush();

      expect(queue.getSnapshot().head?.ref.id).toBe(1);
      noRouteWasUsed();
    });

    it('re-pairing keeps one listener: one request is queued once', async () => {
      service.attachV1CallRequests(client as any, 'pair-1');
      service.attachV1CallRequests(client as any, 'pair-2');
      expect(client.listenerCount('call_request')).toBe(1);

      client.emit('call_request', callRequest(1));
      await flush();

      expect(queue.getSnapshot().head?.ref.id).toBe(1);
      expect(queue.getSnapshot().waiting).toHaveLength(0);
    });
  });

  describe('P4: a v1 session_request (proposal)', () => {
    it('the host head appears for the admitted v1 proposal and no route is used', async () => {
      expect(await service.testDeepLink(link('A'))).toBe(true);
      const proposal = sessionRequest(8101);

      client.emit('session_request', proposal);
      await flush();

      const head = queue.getSnapshot().head;
      expect(head?.ref).toEqual(v1ProposalRefFor(proposal));
      expect(head?.kind).toBe('proposal');
      expect(head?.payload).toBe(proposal);
      noRouteWasUsed();
    });

    it('carries the dApp from the peer metadata', async () => {
      await service.testDeepLink(link('A'));
      const proposal = sessionRequest(8101);

      client.emit('session_request', proposal);
      await flush();

      const head = queue.getSnapshot().head;
      expect(head?.dapp).toEqual({
        name: 'Example dApp',
        url: 'https://dapp.example/app',
        icon: 'https://dapp.example/icon.png',
      });
      expect(head?.firstSeenMs).toBe(
        coordinator.describe(v1ProposalRefFor(proposal))?.firstSeenMs
      );
      expect(head?.firstSeenMs).toBeGreaterThan(0);
    });

    it('a proposal with no peer metadata still queues', async () => {
      await service.testDeepLink(link('A'));

      client.emit('session_request', { id: 8102, chainId: 416001 });
      await flush();

      expect(queue.getSnapshot().head?.ref.id).toBe(8102);
      expect(queue.getSnapshot().head?.dapp).toBeUndefined();
    });

    it('a proposal admitted as a duplicate of an open ref is not pushed', async () => {
      await service.testDeepLink(link('A'));
      const proposal = sessionRequest(8101);
      const ref = v1ProposalRefFor(proposal);
      await coordinator.admit(ref);
      jest
        .spyOn(coordinator, 'admit')
        .mockResolvedValue({ action: 'suppressed', reason: 'duplicate' });

      client.emit('session_request', proposal);
      await flush();

      expect(coordinator.isOpen(ref)).toBe(true);
      expect(queue.getSnapshot().head).toBeNull();
    });

    it('a second link while a v1 proposal is open is refused with the busy toast', async () => {
      await service.testDeepLink(link('A'));
      client.emit('session_request', sessionRequest(8101));
      await flush();

      expect(await service.testDeepLink(link('B'))).toBe(false);

      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'info',
        ...V1_BUSY_TOAST,
      });
      expect(queue.getSnapshot().head?.ref.id).toBe(8101);
      noRouteWasUsed();
    });

    it('a link while a v1 request is the head is refused with the busy toast', async () => {
      await service.testDeepLink(link('A'));
      client.emit('call_request', callRequest(1));
      await flush();

      expect(await service.testDeepLink(link('B'))).toBe(false);

      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'info',
        ...V1_BUSY_TOAST,
      });
      expect(queue.getSnapshot().head?.ref.id).toBe(1);
      noRouteWasUsed();
    });

    it('a link is refused while the client is still answering a closed item', async () => {
      await service.testDeepLink(link('A'));
      const proposal = sessionRequest(8101);
      client.emit('session_request', proposal);
      await flush();
      await coordinator.settle(v1ProposalRefFor(proposal), 'declined');
      await flush();
      expect(coordinator.hasOpenV1Item()).toBe(false);
      client.answering = true;

      expect(await service.testDeepLink(link('B'))).toBe(false);

      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'info',
        ...V1_BUSY_TOAST,
      });

      client.answering = false;
      expect(await service.testDeepLink(link('C'))).toBe(true);
      expect(client.connect).toHaveBeenCalledTimes(2);
    });

    it('a link while a v1 request is waiting is refused with the busy toast', async () => {
      await service.testDeepLink(link('A'));
      client.emit('call_request', callRequest(1));
      client.emit('call_request', callRequest(2));
      await flush();

      expect(await service.testDeepLink(link('B'))).toBe(false);

      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(queue.getSnapshot().waiting.map((w) => w.ref.id)).toEqual([2]);
    });

    it('a malformed link while the host shows is reported by toast, not by a hidden error route', async () => {
      await service.testDeepLink(link('A'));
      client.emit('call_request', callRequest(1));
      await flush();

      expect(await service.testDeepLink('wc:bad@1?bridge=x')).toBe(false);

      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', text1: 'Connection failed' })
      );
      noRouteWasUsed();
    });

    it('a v1 connection error while the host shows is reported by toast', async () => {
      await service.testDeepLink(link('A'));
      client.emit('call_request', callRequest(1));
      await flush();

      client.emit('error', new Error('bridge unreachable'));
      await flush();

      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text2: 'bridge unreachable',
        })
      );
      noRouteWasUsed();
    });

    it('a malformed link while only the result card shows is reported by toast', async () => {
      await service.testDeepLink(link('A'));
      client.emit('call_request', callRequest(1));
      await flush();
      const head = queue.getSnapshot().head!;
      queue.finish(head.ref, { title: 'Done' });
      expect(queue.getSnapshot().head).toBeNull();
      expect(queue.getSnapshot().result).not.toBeNull();

      expect(await service.testDeepLink('wc:bad@1?bridge=x')).toBe(false);

      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', text1: 'Connection failed' })
      );
      noRouteWasUsed();
    });

    it('a malformed link with no host showing still opens the error screen', async () => {
      expect(await service.testDeepLink('wc:bad@1?bridge=x')).toBe(false);

      expect(
        nav.navigate.mock.calls.length + nav.dispatch.mock.calls.length
      ).toBe(1);
      expect(Toast.show).not.toHaveBeenCalled();
    });

    it('once the open proposal is closed a new link connects', async () => {
      await service.testDeepLink(link('A'));
      const proposal = sessionRequest(8101);
      client.emit('session_request', proposal);
      await flush();

      await coordinator.settle(v1ProposalRefFor(proposal), 'declined');

      expect(await service.testDeepLink(link('C'))).toBe(true);
      expect(client.connect).toHaveBeenCalledTimes(2);
    });

    it('a proposal queues behind a request head', async () => {
      await service.testDeepLink(link('A'));
      client.emit('call_request', callRequest(1));
      await flush();

      client.emit('session_request', sessionRequest(8101));
      await flush();

      expect(queue.getSnapshot().head?.kind).toBe('request');
      expect(queue.getSnapshot().waiting.map((w) => w.ref.id)).toEqual([8101]);
    });

    it('past the waiting limit the proposal is answered busy once', async () => {
      await service.testDeepLink(link('A'));
      for (let id = 1; id <= 1 + MAX_WAITING; id++) {
        client.emit('call_request', callRequest(id));
        await flush();
      }

      client.emit('session_request', sessionRequest(8101));
      await flush();

      expect(queue.getSnapshot().waiting).toHaveLength(MAX_WAITING);
      expect(transport.rejectProposalV1).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * TASK-469: a notification tap the deep-link service holds (the app was
 * locked, navigation was not ready, or a WalletConnect review was on screen)
 * belongs to the wallet a wipe deletes, so it is not routed after the wipe. A
 * tap that arrives while the wipe runs is ignored; a tap after it routes as
 * before. The queue and coordinator are the real ones. No key material:
 * payloads are opaque placeholders.
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
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';

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

describe('a wipe and the notification taps the deep-link service holds', () => {
  let service: DeepLinkService;
  let coordinator: RequestCoordinator;
  let queue: RequestQueue;
  let tap: (data: unknown, id?: string) => Promise<void>;
  const nav = {
    isReady: jest.fn(() => true),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    getCurrentRoute: jest.fn((): { name: string } | undefined => undefined),
    addListener: jest.fn(() => () => {}),
  };
  const routed = () => nav.navigate.mock.calls.length;

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
    // The app's singleton: it is the instance the wipe resets.
    (DeepLinkService as unknown as { instance?: DeepLinkService }).instance =
      undefined;
    service = DeepLinkService.getInstance();
    service.setNavigationRef(nav as unknown as NavigationContainerRef<any>);
    service.setUnlockState(false);
    (service as any).setupNotificationHandler();
    tap = jest
      .mocked(notificationService.setNotificationTapHandler)
      .mock.calls.slice(-1)[0][0] as typeof tap;
  });

  afterEach(() => {
    closeWipeWindow();
    coordinator.__resetForTests();
    queue.__resetForTests();
    service.cleanup();
    jest.restoreAllMocks();
  });

  it('a tap held while locked is dropped by the wipe and not routed on unlock', async () => {
    await tap({ type: 'message', sender: 'SENDER' }, 'n-1');
    await flush();
    expect(service.hasPendingNotification()).toBe(true);

    openWipeWindow();
    runWipeResets();
    closeWipeWindow();
    expect(service.hasPendingNotification()).toBe(false);

    service.setUnlockState(true);
    await flush();
    expect(routed()).toBe(0);
  });

  it('a tap that arrives while the wipe runs is ignored', async () => {
    openWipeWindow();
    runWipeResets();
    await tap({ type: 'payment' }, 'n-2');
    await flush();
    closeWipeWindow();
    expect(service.hasPendingNotification()).toBe(false);

    service.setUnlockState(true);
    await flush();
    expect(routed()).toBe(0);
  });

  it('a tap waiting for navigation when the wipe starts is not routed after it', async () => {
    service.setUnlockState(true);
    nav.isReady.mockReturnValue(false);
    // Settles only once it has run, so it is not awaited here.
    const waiting = tap({ type: 'payment' }, 'n-3');
    await flush();

    openWipeWindow();
    runWipeResets();
    closeWipeWindow();
    nav.isReady.mockReturnValue(true);
    service.setNavigationRef(nav as unknown as NavigationContainerRef<any>);
    await waiting;
    await flush();
    expect(routed()).toBe(0);
  });

  it('a tap waiting behind a WalletConnect review is not routed when the wipe empties the queue', async () => {
    service.setUnlockState(true);
    const event = { id: 1, topic: 'topic-1' };
    const ref = requestRefFor(event, 2);
    await coordinator.admit(ref);
    queue.push({ ref, payload: event, firstSeenMs: Date.now() });
    await tap({ type: 'payment' }, 'n-4');
    await flush();
    expect(routed()).toBe(0);

    openWipeWindow();
    runWipeResets();
    queue.resetForWipe();
    closeWipeWindow();
    await flush();
    expect(queue.getSnapshot().head).toBeNull();
    expect(routed()).toBe(0);
  });

  it('after the wipe a tap is held while locked and routed on unlock, as before', async () => {
    openWipeWindow();
    runWipeResets();
    closeWipeWindow();

    await tap({ type: 'payment' }, 'n-5');
    await flush();
    expect(service.hasPendingNotification()).toBe(true);
    service.setUnlockState(true);
    await flush();
    expect(routed()).toBe(1);
  });
});

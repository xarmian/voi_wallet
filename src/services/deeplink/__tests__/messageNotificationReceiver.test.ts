jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

/**
 * Message-notification taps resolve the receiver account only after wallet
 * hydration, and never open Chat under a different account (TASK-465).
 */

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return RN;
});
jest.mock('@react-navigation/native', () => ({
  StackActions: { replace: jest.fn() },
}));
jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: { getInstance: () => ({}) },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: { getInstance: jest.fn() },
}));
jest.mock('@/services/notifications', () => ({
  notificationService: { setNotificationTapHandler: jest.fn() },
}));
jest.mock('@/store/networkStore', () => ({
  useNetworkStore: { getState: () => ({ currentNetwork: 'voi-mainnet' }) },
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: () => ({ name: 'Voi' }),
}));

const mockState: any = {};
jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => mockState },
}));

import { DeepLinkService } from '../index';

const RECEIVER = 'RECEIVERADDR';
const SENDER = 'SENDERADDR';
const tap = { type: 'message', sender: SENDER, receiver: RECEIVER };

const walletWith = (active: string) => ({
  activeAccountId: active,
  accounts: [
    { id: 'other', address: 'OTHERADDR' },
    { id: 'recv', address: RECEIVER },
  ],
});

describe('message notification receiver switch (TASK-465)', () => {
  let service: DeepLinkService;
  let navigateToRoute: jest.Mock;
  const routes = () =>
    navigateToRoute.mock.calls.map((c) => c[0].params.params.screen);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    service = new DeepLinkService();
    navigateToRoute = jest.fn();
    (service as any).navigateToRoute = navigateToRoute;
    mockState.setActiveAccount = jest.fn(async (id: string) => {
      mockState.wallet = walletWith(id);
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const run = async () => {
    const p = (service as any).handleNotificationNavigation(tap);
    await jest.advanceTimersByTimeAsync(200);
    await p;
  };

  it('awaits hydration, switches to the receiver, then opens Chat', async () => {
    mockState.isInitialized = false;
    mockState.wallet = null;
    let hydrate: () => void = () => {};
    mockState.initialize = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          hydrate = () => {
            mockState.wallet = walletWith('other');
            mockState.isInitialized = true;
            resolve();
          };
        })
    );

    const p = (service as any).handleNotificationNavigation(tap);
    await jest.advanceTimersByTimeAsync(200);
    // Still hydrating: nothing resolved or routed yet.
    expect(mockState.setActiveAccount).not.toHaveBeenCalled();
    expect(navigateToRoute).not.toHaveBeenCalled();
    hydrate();
    await jest.advanceTimersByTimeAsync(200);
    await p;

    expect(mockState.initialize).toHaveBeenCalledTimes(1);
    expect(mockState.setActiveAccount).toHaveBeenCalledWith('recv');
    expect(routes()).toEqual(['MessagesInbox', 'Chat']);
  });

  it('falls back to the inbox when the receiver is not in the wallet', async () => {
    mockState.isInitialized = true;
    mockState.wallet = {
      activeAccountId: 'other',
      accounts: [{ id: 'other', address: 'OTHERADDR' }],
    };
    mockState.initialize = jest.fn();

    await run();

    expect(mockState.initialize).not.toHaveBeenCalled();
    expect(mockState.setActiveAccount).not.toHaveBeenCalled();
    expect(routes()).toEqual(['MessagesInbox']);
  });

  it('still opens the inbox, not Chat, when hydration fails', async () => {
    mockState.isInitialized = false;
    mockState.wallet = null;
    mockState.initialize = jest.fn(async () => {
      throw new Error('boom');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(routes()).toEqual(['MessagesInbox']);
  });

  it('does not open Chat if the active account changes before the delayed push', async () => {
    mockState.isInitialized = true;
    mockState.wallet = walletWith('recv');
    mockState.initialize = jest.fn();

    const p = (service as any).handleNotificationNavigation(tap);
    await jest.advanceTimersByTimeAsync(10);
    mockState.wallet = walletWith('other');
    await jest.advanceTimersByTimeAsync(200);
    await p;

    expect(routes()).toEqual(['MessagesInbox']);
  });
});

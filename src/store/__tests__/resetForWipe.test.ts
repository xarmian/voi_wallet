/**
 * TASK-492: a wipe resets every store that holds the previous wallet's data in
 * memory, without persisting, and a write that was already under way when the
 * wipe started does not land afterwards.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/platform', () => ({
  getCrypto: () => ({ randomUUID: () => 'uuid' }),
}));
jest.mock('@/services/messaging', () => ({
  __esModule: true,
  default: { clearKeyCache: jest.fn() },
}));
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: { isUnlocked: () => true },
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: null }) },
}));
jest.mock('@/services/mimir', () => ({ __esModule: true, default: {} }));
jest.mock('@/services/envoi', () => ({
  __esModule: true,
  default: { getInstance: () => ({}) },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import MessagingService from '@/services/messaging';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';
import { useMessagesStore } from '../messagesStore';
import { useClaimableStore } from '../claimableStore';
import {
  useRemoteSignerStore,
  __drainProcessedPersistChainForTests,
} from '../remoteSignerStore';

const ADDRESS = 'ACCOUNTA';

beforeEach(async () => {
  await AsyncStorage.clear();
  await __drainProcessedPersistChainForTests();
});

describe('messages', () => {
  test('threads, cursor, hidden set and polling are cleared without a write', async () => {
    const interval = setInterval(() => {}, 1_000_000);
    useMessagesStore.setState({
      threads: {
        F: {
          friendAddress: 'F',
          lastMessageTimestamp: 1,
          unreadCount: 2,
          messages: [],
        },
      },
      currentUserAddress: ADDRESS,
      isInitialized: true,
      isKeyRegistered: true,
      committedId: 42,
      hiddenThreads: new Set(['F']),
      showHiddenThreads: true,
      pollingInterval: interval,
    });
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    runWipeResets();
    const state = useMessagesStore.getState();
    expect(state.threads).toEqual({});
    expect(state.currentUserAddress).toBeNull();
    expect(state.committedId).toBeNull();
    expect(state.hiddenThreads.size).toBe(0);
    expect(state.isKeyRegistered).toBe(false);
    expect(state.isInitialized).toBe(false);
    expect(state.pollingInterval).toBeNull();
    expect(MessagingService.clearKeyCache).toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    clearInterval(interval);
    setItem.mockRestore();
  });

  test('a hide issued for the previous account after the reset writes nothing', async () => {
    useMessagesStore.setState({ currentUserAddress: ADDRESS });
    runWipeResets();
    await useMessagesStore.getState().hideThread('F');
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });
});

describe('claimable', () => {
  test('approvals, items and the hidden set are cleared', () => {
    useClaimableStore.setState({
      approvals: [{ owner: 'O' } as never],
      claimableItems: [{ id: 'x' } as never],
      itemsAccountAddress: ADDRESS,
      hiddenApprovals: new Set(['x']),
      hiddenApprovalsAccount: ADDRESS,
      currentAccountAddress: ADDRESS,
      lastFetchedAt: { [ADDRESS]: 1 },
    });
    runWipeResets();
    const state = useClaimableStore.getState();
    expect(state.approvals).toEqual([]);
    expect(state.claimableItems).toEqual([]);
    expect(state.hiddenApprovals.size).toBe(0);
    expect(state.currentAccountAddress).toBeNull();
    expect(state.lastFetchedAt).toEqual({});
  });

  test('hiding an approval during a wipe writes nothing; after the wipe it persists', async () => {
    useClaimableStore.setState({
      currentAccountAddress: ADDRESS,
      hiddenApprovals: new Set<string>(),
    });
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    openWipeWindow();
    try {
      runWipeResets();
      // A screen still mounted puts the account back while the wipe runs.
      useClaimableStore.setState({ currentAccountAddress: ADDRESS });
      await useClaimableStore.getState().hideApproval('x');
      await useClaimableStore.getState().unhideApproval('y');
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      closeWipeWindow();
    }
    await useClaimableStore.getState().hideApproval('z');
    expect(setItem).toHaveBeenCalledWith(
      `@claimable/hidden/${ADDRESS}`,
      expect.stringContaining('z')
    );
    setItem.mockRestore();
  });

  test('a fetch that starts during a wipe does not claim the store for its account', async () => {
    openWipeWindow();
    try {
      runWipeResets();
      await useClaimableStore.getState().fetchApprovals(ADDRESS);
      expect(useClaimableStore.getState().currentAccountAddress).toBeNull();
    } finally {
      closeWipeWindow();
    }
  });
});

describe('remote signer', () => {
  test('pairings, signer config and processed ids are cleared, and the mode is back to wallet', () => {
    useRemoteSignerStore.setState({
      appMode: 'signer',
      isInitialized: true,
      signerConfig: { deviceId: 'd', deviceName: 'n', requirePinPerTxn: false },
      processedRequestIds: new Set(['r1']),
      pairedSigners: new Map([['d', { deviceId: 'd' } as never]]),
    });
    runWipeResets();
    const state = useRemoteSignerStore.getState();
    expect(state.appMode).toBe('wallet');
    expect(state.signerConfig).toBeNull();
    expect(state.processedRequestIds.size).toBe(0);
    expect(state.pairedSigners.size).toBe(0);
    expect(state.isInitialized).toBe(false);
  });

  test('a processed-id write queued before the reset does not land after it', async () => {
    let release: () => void = () => {};
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    setItem.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    // The first write is held; the second queues behind it.
    useRemoteSignerStore.getState().markRequestProcessed('r1');
    useRemoteSignerStore.getState().markRequestProcessed('r2');
    await Promise.resolve();
    await Promise.resolve();
    runWipeResets();
    release();
    await __drainProcessedPersistChainForTests();
    expect(setItem).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
  });

  test('a processed-id write that failed before the reset is not retried after it', async () => {
    let fail: (error: Error) => void = () => {};
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    setItem.mockImplementationOnce(
      () => new Promise<void>((_, reject) => (fail = reject))
    );
    useRemoteSignerStore.getState().markRequestProcessed('r1');
    for (let i = 0; i < 10 && setItem.mock.calls.length === 0; i++)
      await Promise.resolve();
    expect(setItem).toHaveBeenCalledTimes(1);
    runWipeResets();
    fail(new Error('disk full'));
    await __drainProcessedPersistChainForTests();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
    setItem.mockRestore();
  });

  // Each action that writes, started while a wipe runs. The state is set
  // after the reset so that each one reaches its write.
  const signer = (deviceId: string) =>
    ({ deviceId, deviceName: deviceId, lastActivity: 1 }) as never;
  const writers: [string, () => Promise<unknown>][] = [
    ['setAppMode', () => useRemoteSignerStore.getState().setAppMode('signer')],
    [
      'initializeSignerConfig',
      () => useRemoteSignerStore.getState().initializeSignerConfig('Phone'),
    ],
    [
      'updateSignerDeviceName',
      () => useRemoteSignerStore.getState().updateSignerDeviceName('Renamed'),
    ],
    [
      'addPairedSigner',
      () => useRemoteSignerStore.getState().addPairedSigner(signer('b')),
    ],
    [
      'removePairedSigner',
      () => useRemoteSignerStore.getState().removePairedSigner('a'),
    ],
    [
      'updateSignerActivity',
      () => useRemoteSignerStore.getState().updateSignerActivity('a'),
    ],
  ];
  test.each(writers)(
    '%s started while a wipe runs writes nothing to storage',
    async (_name, write) => {
      const setItem = jest.spyOn(AsyncStorage, 'setItem');
      openWipeWindow();
      try {
        runWipeResets();
        useRemoteSignerStore.setState({
          signerConfig: {
            deviceId: 'd',
            deviceName: 'n',
            requirePinPerTxn: false,
          },
          pairedSigners: new Map([['a', signer('a')]]),
        });
        await write();
        expect(setItem).not.toHaveBeenCalled();
        expect(await AsyncStorage.getAllKeys()).toEqual([]);
      } finally {
        closeWipeWindow();
        setItem.mockRestore();
      }
    }
  );
});

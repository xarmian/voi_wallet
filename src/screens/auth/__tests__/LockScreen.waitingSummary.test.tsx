import React from 'react';
import { AppState } from 'react-native';
import { act, render, fireEvent } from '@testing-library/react-native';

let mockLocked = true;
const mockUnlock = jest.fn();
const mockBiometric = jest.fn();
const mockHaptic = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      biometricEnabled: true,
      isLocked: mockLocked,
      isAuthenticated: !mockLocked,
      authChecked: true,
      securityUnavailable: false,
      hasPin: true,
      pinSetupResume: false,
    },
    unlock: mockUnlock,
    unlockWithBiometrics: mockBiometric,
    recheckAuthState: jest.fn(),
    consumeUnlockRefusal: jest.fn(),
  }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getPinThrottleState: jest.fn(async () => ({
      lockedUntil: null,
      attemptsRemaining: 5,
    })),
    getCredentialSource: jest.fn(async () => 'pin'),
  },
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));
jest.mock('@/services/wipe', () => ({ wipeWalletData: jest.fn() }));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
  showWipeIncompleteNotice: jest.fn(),
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => new Proxy({}, { get: () => ({}) }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/utils/haptics', () => ({
  hapticNotify: (...args: unknown[]) => mockHaptic(...args),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/screens/walletconnect/SessionProposalScreen', () => ({
  ConnectReview: () => null,
}));
jest.mock('@/screens/wallet/UniversalTransactionSigningScreen', () => ({
  TransactionReview: () => null,
}));
jest.mock('@/services/walletconnect/signRequestController', () => ({
  SignRequestController: jest.fn(() => ({
    start: jest.fn(),
    dispose: jest.fn(),
  })),
}));
import LockScreen from '../LockScreen';
import RootLockBoundary from '@/components/RootLockBoundary';
import WalletConnectHost from '@/components/wcHost/WalletConnectHost';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { RequestCoordinator } from '@/services/walletconnect/requestCoordinator';
import { buildWaitingSummary } from '@/services/walletconnect/waitingSummary';
import { RootLockFocusProvider } from '@/contexts/LockFocusContext';
let queue: RequestQueue;
const coordinator = { isOpen: () => true, subscribe: () => () => {} };
const navigation = {
  isReady: () => true,
  getCurrentRoute: () => ({ name: 'Main' }),
  addListener: jest.fn(() => () => {}),
  resetRoot: jest.fn(),
};
const secrets = {
  address: 'DISTINCT_PRIVATE_ADDRESS',
  amount: '987654321',
  assetId: '424242',
  note: 'DISTINCT_PRIVATE_NOTE',
};
const push = (id = 1, kind: 'proposal' | 'request' = 'request') =>
  queue.push({
    ref: { version: 2, kind, topic: 'summary-fixture', id },
    payload: secrets,
    dapp: { name: 'fixture dapp', url: 'https://fixture.example' },
    network: 'Voi Network',
    firstSeenMs: Date.now(),
  });
const tree = () => (
  <RootLockBoundary navigationRef={{ current: navigation }}>
    <WalletConnectHost />
  </RootLockBoundary>
);
beforeEach(() => {
  mockLocked = true;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  mockBiometric.mockResolvedValue(false);
  mockUnlock.mockResolvedValue(false);
  queue = new RequestQueue({ coordinator });
  jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
  jest
    .spyOn(RequestCoordinator, 'getInstance')
    .mockReturnValue(coordinator as unknown as RequestCoordinator);
});
afterEach(() => {
  queue.__resetForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
it.each(['request', 'proposal'] as const)(
  'DEFECT SUMMARY-LEAK MUTANT real boundary %s summary exposes only summary metadata, never any payload field',
  async (kind) => {
    push(1, kind);
    push(2, kind);
    const summary = buildWaitingSummary(queue.getSnapshot(), Date.now())!;
    const view = await render(tree());
    for (const text of [
      summary.title,
      summary.dappLine,
      summary.detailLine,
      summary.ageLine,
      summary.moreLine!,
    ])
      expect(view.getByText(text)).toBeTruthy();
    const rendered = JSON.stringify(view.toJSON());
    for (const secret of Object.values(secrets))
      expect(rendered).not.toContain(secret);
    mockLocked = false;
    await view.rerender(tree());
    expect(view.queryByText(summary.title)).toBeNull();
  }
);
it('DEFECT unlocked ordinary LockScreen hides waiting summary', async () => {
  push();
  mockLocked = false;
  const view = await render(
    <RootLockFocusProvider>
      <LockScreen />
    </RootLockFocusProvider>
  );
  expect(view.queryByText('WalletConnect request waiting')).toBeNull();
});
it('DEFECT arrival preserves typed digits, focus and navigation', async () => {
  const view = await render(tree());
  await fireEvent.press(view.getByText('1'));
  await fireEvent.press(view.getByText('2'));
  const isCurrent = mockBiometric.mock.calls[0][0] as () => boolean;
  expect(isCurrent()).toBe(true);
  const focusCalls = mockBiometric.mock.calls.length;
  await act(async () => {
    push();
  });
  expect(view.getByText('WalletConnect request waiting')).toBeTruthy();
  expect(isCurrent()).toBe(true);
  expect(mockBiometric).toHaveBeenCalledTimes(focusCalls);
  expect(navigation.resetRoot).not.toHaveBeenCalled();
  for (const digit of ['3', '4', '5', '6'])
    await fireEvent.press(view.getByText(digit));
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  // Inspect only the call count: PIN values must never enter assertion diagnostics.
});
it('DEFECT age refreshes on 30 second tick and interval is cleared on unmount', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(1800000000000);
  push();
  push(2);
  jest.setSystemTime(1800000045000);
  const view = await render(tree());
  const firstAge = buildWaitingSummary(
    queue.getSnapshot(),
    Date.now()
  )!.ageLine;
  expect(view.getByText(firstAge)).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  const nextAge = buildWaitingSummary(queue.getSnapshot(), Date.now())!.ageLine;
  expect(nextAge).not.toBe(firstAge);
  expect(view.getByText(nextAge)).toBeTruthy();
  const clear = jest.spyOn(global, 'clearInterval');
  await view.unmount();
  expect(clear).toHaveBeenCalled();
});

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import RootLockBoundary from '../RootLockBoundary';
import LockedRequestGate from '../walletconnect/LockedRequestGate';
import { useAuth } from '@/contexts/AuthContext';
import { reviewGrant } from '@/services/auth/reviewGrant';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

// PIN on the premise behind the host's accepted residual: the unlock gate that
// a surviving grant would need cannot be pressed while the root cover is up.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/contexts/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('@/utils/lockCover', () => ({ setCovered: jest.fn() }));
jest.mock('@/screens/auth/LockScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () =>
    new Proxy({}, { get: () => ({}) }) as Record<string, object>,
}));
jest.mock('@/hooks/useSecureScreen', () => ({
  useSecureScreen: jest.fn(),
  useAppSwitcherProtection: jest.fn(),
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getCredentialSource: jest.fn(),
  },
}));

const base = {
  authChecked: true,
  isLocked: false,
  isAuthenticated: true,
  hasPin: true,
  pinSetupResume: false,
  securityUnavailable: false,
};
const navigationRef = {
  current: {
    isReady: () => true,
    getCurrentRoute: () => ({ name: 'Main' }),
    addListener: () => () => {},
    resetRoot: () => {},
  },
};

beforeEach(() => {
  jest
    .mocked(AccountSecureStorage.getCredentialSource)
    .mockResolvedValue('pin');
});
afterEach(async () => {
  await act(async () => {});
});

async function run(state: { isLocked: boolean; isAuthenticated: boolean }) {
  {
    const unlock = jest.spyOn(reviewGrant, 'unlock').mockResolvedValue(true);
    const onReject = jest.fn();
    const gate = () => (
      <RootLockBoundary navigationRef={navigationRef}>
        <LockedRequestGate
          requestKey="gate-key"
          network="fixture network"
          biometricEnabled
          onReject={onReject}
        />
      </RootLockBoundary>
    );
    jest.mocked(useAuth).mockReturnValue({
      authState: { ...base, ...state },
    } as ReturnType<typeof useAuth>);
    const view = await render(gate());
    const press = async (label: string) =>
      await fireEvent.press(
        view.getByText(label, { includeHiddenElements: true })
      );
    await press('Unlock to review');
    await press('Reject');
    expect(unlock).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();

    jest.mocked(useAuth).mockReturnValue({
      authState: base,
    } as ReturnType<typeof useAuth>);
    await view.rerender(gate());
    await press('Reject');
    expect(onReject).toHaveBeenCalledTimes(1);
    await press('Unlock to review');
    expect(unlock).toHaveBeenCalledTimes(1);
    unlock.mockRestore();
    await view.unmount();
  }
}
it('DEFECT the unlock gate takes no press under the cover (locked, unauthenticated) and takes it when uncovered', async () => {
  await run({ isLocked: true, isAuthenticated: true });
  await run({ isLocked: false, isAuthenticated: false });
});

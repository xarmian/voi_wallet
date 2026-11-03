import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import RemovedAccountNoticeHost from '../RemovedAccountNoticeHost';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    readUnexplainedRemovals: jest.fn(),
    clearUnexplainedRemoval: jest.fn(),
  },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual };
});

const record = { id: 'one', address: 'ABCDEF123456WXYZ', label: 'Savings' };
describe('RemovedAccountNoticeHost', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      AccountSecureStorage.clearUnexplainedRemoval as jest.Mock
    ).mockResolvedValue(undefined);
  });
  it('clears and then calls reimport', async () => {
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue([record]);
    const onReimport = jest.fn();
    const screen = await render(
      <RemovedAccountNoticeHost onReimport={onReimport} />
    );
    fireEvent.press(await screen.findByText('Re-import'));
    await waitFor(() =>
      expect(AccountSecureStorage.clearUnexplainedRemoval).toHaveBeenCalledWith(
        'one'
      )
    );
    expect(onReimport).toHaveBeenCalledTimes(1);
  });
  it('dismisses and clears without reimport', async () => {
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue([record]);
    const onReimport = jest.fn();
    const screen = await render(
      <RemovedAccountNoticeHost onReimport={onReimport} />
    );
    await screen.findByText('Re-import');
    fireEvent.press(
      screen.container.queryAll(
        (n: any) => n.props?.testID === 'removed-account-dismiss'
      )[0]
    );
    await waitFor(() =>
      expect(AccountSecureStorage.clearUnexplainedRemoval).toHaveBeenCalledWith(
        'one'
      )
    );
    expect(onReimport).not.toHaveBeenCalled();
  });
  it('renders nothing and only reads storage for an empty list', async () => {
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue([]);
    const screen = await render(
      <RemovedAccountNoticeHost onReimport={jest.fn()} />
    );
    await waitFor(() =>
      expect(
        AccountSecureStorage.readUnexplainedRemovals
      ).toHaveBeenCalledTimes(1)
    );
    expect(screen.toJSON()).toBeNull();
    expect(AccountSecureStorage.clearUnexplainedRemoval).not.toHaveBeenCalled();
  });
});

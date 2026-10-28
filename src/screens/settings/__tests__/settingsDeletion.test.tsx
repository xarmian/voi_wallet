import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import SettingsScreen from '../SettingsScreen';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

let mockActive: AccountMetadata;
let mockAccounts: AccountMetadata[];
const mockDelete = jest.fn();
const mockNavigate = jest.fn();
const mockNavigation = { navigate: mockNavigate, goBack: jest.fn() };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockActive,
  useAccounts: () => mockAccounts,
  useWalletSettings: () => ({}),
  useWalletStore: Object.assign(
    (selector: (state: object) => unknown) =>
      selector({ deleteAccount: mockDelete }),
    { getState: () => ({ wallet: { accounts: mockAccounts } }) }
  ),
}));
jest.mock('@/store/networkStore', () => ({
  useIsCurrentNetworkHealthy: () => true,
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { probeSecretPresenceStrict: jest.fn() },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/account/AccountListModal', () => () => null);
jest.mock('@/components/account/AddAccountModal', () => () => null);
jest.mock('@/components/account/RenameAccountModal', () => () => null);
jest.mock('@/components/common/ThemeSwitcher', () => () => null);
jest.mock('@/components/common/LocaleSwitcher', () => () => null);
jest.mock('@/components/common/NFTThemeSelector', () => () => null);
jest.mock('@/components/network/NetworkSwitcher', () => () => null);
jest.mock('@/components/network/NetworkIndicator', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));
const probe = jest.mocked(AccountSecureStorage.probeSecretPresenceStrict);
const account = (overrides: object = {}): AccountMetadata =>
  ({
    id: 'original',
    address: 'ORIGINAL_ADDRESS',
    type: AccountType.REKEYED,
    authAddress: 'SIGNER_ADDRESS',
    originalOwner: false,
    ...overrides,
  }) as AccountMetadata;

beforeEach(() => {
  mockActive = account({ type: AccountType.STANDARD, label: 'Alice' });
  mockAccounts = [mockActive];
  mockDelete.mockReset().mockResolvedValue(undefined);
  probe.mockReset();
  probe.mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());

const open = async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await render(<SettingsScreen />);
  await fireEvent.press(view.getByText(/^Delete "/));
  return { view, alert };
};
const pressAlert = async (alert: jest.SpyInstance, title: string) => {
  const buttons = alert.mock.calls.at(-1)?.[2];
  const button = buttons?.find((b: { text: string }) => b.text === title);
  expect(button).toBeDefined();
  await act(async () => {
    await button.onPress?.();
  });
};
const typeDelete = async (
  view: Awaited<ReturnType<typeof render>>,
  text = 'DELETE'
) => {
  await fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    text
  );
};

it.each([
  ['standard', AccountType.STANDARD, false, false, true],
  ['owner', AccountType.REKEYED, true, false, true],
  ['present', AccountType.REKEYED, false, true, true],
  ['ERROR', AccountType.REKEYED, false, new Error('locked'), true],
  ['absent', AccountType.REKEYED, false, false, false],
  ['watch', AccountType.WATCH, false, false, false],
  ['ledger', AccountType.LEDGER, false, false, false],
  ['remote', AccountType.REMOTE_SIGNER, false, false, false],
] as const)(
  '%s selects the required flow',
  async (_name, type, originalOwner, result, protectedAccount) => {
    mockActive = account({ type, originalOwner });
    mockAccounts = [mockActive];
    if (result instanceof Error) probe.mockRejectedValue(result);
    else probe.mockResolvedValue(result);
    const { view, alert } = await open();
    expect(alert.mock.calls[0][0]).toBe(
      protectedAccount ? 'Back up your recovery phrase first' : 'Delete Account'
    );
    if (protectedAccount) {
      await pressAlert(alert, 'I have my phrase');
      expect(mockDelete).not.toHaveBeenCalled();
      await typeDelete(view);
      await fireEvent.press(view.getByLabelText('Delete account'));
    } else await pressAlert(alert, 'Delete');
    expect(mockDelete).toHaveBeenCalledWith('original');
  }
);

it.each([undefined, false, 'true', true])(
  'uses literal own verification: %s',
  async (backupVerified) => {
    mockActive = account({
      type: AccountType.STANDARD,
      label: 'Alice',
      backupVerified,
    });
    mockAccounts = [
      mockActive,
      account({ id: 'signer', backupVerified: true }),
    ];
    const { alert } = await open();
    const body = alert.mock.calls[0][1];
    expect(body).toContain(
      "Deleting Alice removes its private key from this device. Without its 25-word recovery phrase, you'll permanently lose access to this account."
    );
    expect(
      body?.includes("You haven't confirmed a backup of this phrase yet.")
    ).toBe(backupVerified !== true);
  }
);

it('offers the existing phrase handler with the pinned address', async () => {
  const { view, alert } = await open();
  mockActive = account({ id: 'other', address: 'OTHER' });
  await view.rerender(<SettingsScreen />);
  await pressAlert(alert, 'Show recovery phrase');
  await pressAlert(alert, 'Continue');
  expect(mockNavigate).toHaveBeenCalledWith('ShowRecoveryPhrase', {
    accountAddress: 'ORIGINAL_ADDRESS',
  });
  expect(mockDelete).not.toHaveBeenCalled();
});

it('omits phrase access when canShowPhrase is false, and waits for the tap probe', async () => {
  mockActive = account();
  mockAccounts = [mockActive];
  let resolve!: (present: boolean) => void;
  probe.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  const alert = jest.spyOn(Alert, 'alert');
  const view = await render(<SettingsScreen />);
  await fireEvent.press(view.getByText(/^Delete "/));
  expect(alert).not.toHaveBeenCalled();
  await act(async () => resolve(true));
  expect(alert.mock.calls[0][2]?.map((b) => b.text)).toEqual([
    'Cancel',
    'I have my phrase',
  ]);
});

it('requires exact case with trimming, and resets on cancel/back', async () => {
  const { view, alert } = await open();
  await pressAlert(alert, 'Cancel');
  expect(mockDelete).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText(/^Delete "/));
  await pressAlert(alert, 'I have my phrase');
  for (const text of ['wrong', 'delete', 'Delete', '']) {
    await typeDelete(view, text);
    expect(view.getByLabelText('Delete account')).toBeDisabled();
    await fireEvent.press(view.getByLabelText('Delete account'));
  }
  const input = view.getByLabelText('Type DELETE to confirm account deletion');
  expect(input.props.autoCorrect).toBe(false);
  expect(input.props.autoCapitalize).toBe('none');
  await typeDelete(view, ' DELETE ');
  expect(view.getByLabelText('Delete account')).toBeEnabled();
  await fireEvent.press(view.getByLabelText('Cancel account deletion'));
  await fireEvent.press(view.getByText(/^Delete "/));
  await pressAlert(alert, 'I have my phrase');
  expect(view.getByLabelText('Delete account')).toBeDisabled();
  await fireEvent(view.getByTestId('delete-account-modal'), 'requestClose');
  expect(mockDelete).not.toHaveBeenCalled();
});

it('deletes the pinned account after switching active accounts', async () => {
  const { view, alert } = await open();
  await pressAlert(alert, 'I have my phrase');
  mockActive = account({ id: 'other', address: 'OTHER' });
  mockAccounts = [...mockAccounts, mockActive];
  await view.rerender(<SettingsScreen />);
  await typeDelete(view);
  await fireEvent.press(view.getByLabelText('Delete account'));
  expect(mockDelete).toHaveBeenCalledWith('original');
  expect(mockDelete).not.toHaveBeenCalledWith('other');
});

it.each(['removed', 'type', 'address'])(
  'aborts when target is %s',
  async (change) => {
    const { view, alert } = await open();
    await pressAlert(alert, 'I have my phrase');
    mockAccounts =
      change === 'removed'
        ? []
        : [
            account({
              type:
                change === 'type' ? AccountType.WATCH : AccountType.STANDARD,
              address: change === 'address' ? 'CHANGED' : mockActive.address,
            }),
          ];
    await typeDelete(view);
    await fireEvent.press(view.getByLabelText('Delete account'));
    expect(mockDelete).not.toHaveBeenCalled();
    expect(alert).toHaveBeenLastCalledWith(
      'Account not deleted',
      expect.any(String)
    );
  }
);

it('reports deletion failure', async () => {
  mockDelete.mockRejectedValue(new Error('storage failed'));
  const { view, alert } = await open();
  await pressAlert(alert, 'I have my phrase');
  await typeDelete(view);
  await fireEvent.press(view.getByLabelText('Delete account'));
  expect(alert).toHaveBeenLastCalledWith('Delete Failed', 'storage failed');
});

it('runs a rapid double confirmation only once', async () => {
  let finish!: () => void;
  mockDelete.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const { view, alert } = await open();
  await pressAlert(alert, 'I have my phrase');
  await typeDelete(view);
  const button = view.getByLabelText('Delete account');
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  await act(async () => finish());
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

it('a dismissed alert and a finished deletion both leave Delete usable', async () => {
  const { view, alert } = await open();
  const options = alert.mock.calls.at(-1)?.[3] as { onDismiss?: () => void };
  await act(async () => options.onDismiss?.());
  expect(mockDelete).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText(/^Delete "/));
  await pressAlert(alert, 'I have my phrase');
  await typeDelete(view);
  await fireEvent.press(view.getByLabelText('Delete account'));
  expect(mockDelete).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByText(/^Delete "/));
  await pressAlert(alert, 'I have my phrase');
  await typeDelete(view);
  await fireEvent.press(view.getByLabelText('Delete account'));
  expect(mockDelete).toHaveBeenCalledTimes(2);
});

it('an unexpected throw during confirmation leaves Delete usable and is reported', async () => {
  const { view, alert } = await open();
  await pressAlert(alert, 'I have my phrase');
  await typeDelete(view);
  // The account vanishes from a broken store read: confirmation throws.
  const accounts = mockAccounts;
  mockAccounts = undefined as unknown as AccountMetadata[];
  await fireEvent.press(view.getByLabelText('Delete account'));
  mockAccounts = accounts;
  expect(mockDelete).not.toHaveBeenCalled();
  expect(alert).toHaveBeenLastCalledWith('Delete Failed', expect.any(String));
  await fireEvent.press(view.getByText(/^Delete "/));
  await pressAlert(alert, 'I have my phrase');
  await typeDelete(view);
  await fireEvent.press(view.getByLabelText('Delete account'));
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

it('an unexpected throw before the first alert leaves Delete usable and is reported', async () => {
  // A non-standard account goes through the custody probe at tap time; make
  // the helper itself throw there (it already catches probe rejections).
  mockActive = account({ type: AccountType.REKEYED, label: 'Bob' });
  mockAccounts = [mockActive];
  probe.mockResolvedValue(true);
  const alert = jest.spyOn(Alert, 'alert');
  const view = await render(<SettingsScreen />);
  await act(async () => {});
  const helper = require('@/services/wallet/listDeletionProtection');
  const spy = jest
    .spyOn(helper, 'isListDeletionProtected')
    .mockRejectedValueOnce(new Error('unexpected'));
  await fireEvent.press(view.getByText(/^Delete "/));
  await act(async () => {});
  expect(alert).toHaveBeenLastCalledWith('Delete Failed', expect.any(String));
  spy.mockRestore();
  await fireEvent.press(view.getByText(/^Delete "/));
  await pressAlert(alert, 'I have my phrase');
  await typeDelete(view);
  await fireEvent.press(view.getByLabelText('Delete account'));
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

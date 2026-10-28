import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import AccountListItem from '../AccountListItem';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { probeSecretPresenceStrict: jest.fn() },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});
jest.mock('../AccountAvatar', () => () => null);
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({ wallet: { accounts: [] } }),
  useAccountBalance: () => ({ balance: undefined, isLoading: false }),
}));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetworkConfig: () => ({ nativeToken: 'VOI' }),
}));

const probe = jest.mocked(AccountSecureStorage.probeSecretPresenceStrict);
const account = (overrides: object = {}): AccountMetadata =>
  ({
    id: 'rekeyed',
    address: 'ORIGINAL_ADDRESS',
    type: AccountType.REKEYED,
    authAddress: 'SIGNER_ADDRESS',
    canSign: false,
    ...overrides,
  }) as AccountMetadata;
const onDelete = jest.fn();
const row = (metadata: AccountMetadata) => (
  <AccountListItem
    account={metadata}
    isActive={false}
    onSelect={jest.fn()}
    onDelete={onDelete}
  />
);

beforeEach(() => {
  probe.mockReset();
  probe.mockResolvedValue(false);
});

afterEach(() => jest.restoreAllMocks());

it('hides original-owner REKEYED without probing even when the vault says absent', async () => {
  const view = await render(row(account({ originalOwner: true })));
  expect(view.queryByText('trash-outline')).toBeNull();
  expect(probe).not.toHaveBeenCalled();
});

it.each([
  ['absent', false, true],
  ['present', true, false],
  ['error', new Error('vault locked'), false],
] as const)('handles a strict probe %s', async (_name, result, visible) => {
  if (result instanceof Error) probe.mockRejectedValue(result);
  else probe.mockResolvedValue(result);
  const view = await render(row(account()));
  expect(Boolean(view.queryByText('trash-outline'))).toBe(visible);
  expect(probe).toHaveBeenCalledWith('rekeyed');
});

it('hides while pending, then preserves the deletion confirmation and callback', async () => {
  let resolve!: (present: boolean) => void;
  probe.mockReturnValue(new Promise((done) => (resolve = done)));
  const alert = jest.spyOn(Alert, 'alert');
  const view = await render(row(account()));
  expect(view.queryByText('trash-outline')).toBeNull();
  await act(async () => resolve(false));
  await fireEvent.press(view.getByText('trash-outline'));
  expect(alert).toHaveBeenCalledWith(
    'Delete Account',
    expect.any(String),
    expect.any(Array)
  );
  expect(onDelete).not.toHaveBeenCalled();
  alert.mock.calls[0][2]?.[1].onPress?.();
  expect(onDelete).toHaveBeenCalledWith('rekeyed');
});

it.each([
  [AccountType.STANDARD, false],
  [AccountType.WATCH, true],
  [AccountType.LEDGER, true],
  [AccountType.REMOTE_SIGNER, true],
])('keeps %s deletion unchanged', async (type, visible) => {
  const view = await render(row(account({ type })));
  expect(Boolean(view.queryByText('trash-outline'))).toBe(visible);
  expect(probe).not.toHaveBeenCalled();
});

it('hides immediately on account change and ignores a stale absent result', async () => {
  let resolveOld!: (present: boolean) => void;
  probe.mockReturnValueOnce(new Promise((done) => (resolveOld = done)));
  probe.mockReturnValueOnce(new Promise(() => {}));
  const view = await render(row(account()));
  await view.rerender(row(account({ id: 'other' })));
  await act(async () => resolveOld(false));
  expect(view.queryByText('trash-outline')).toBeNull();
});

it('removes a previously allowed action when metadata becomes protected', async () => {
  const metadata = account();
  const alert = jest.spyOn(Alert, 'alert');
  const view = await render(row(metadata));
  expect(view.queryByText('trash-outline')).toBeTruthy();
  await view.rerender(
    row({ ...metadata, originalOwner: true } as AccountMetadata)
  );
  expect(view.queryByText('trash-outline')).toBeNull();
  expect(alert).not.toHaveBeenCalled();
});

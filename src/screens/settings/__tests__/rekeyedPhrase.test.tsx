import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import SettingsScreen from '../SettingsScreen';
import ShowRecoveryPhraseScreen from '../ShowRecoveryPhraseScreen';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';

let mockActive: AccountMetadata;
let mockAccounts: AccountMetadata[];
let mockParams: { accountAddress?: string };
const mockNavigate = jest.fn();
const mockSecureScreen = jest.fn();
const mockNavigation = { navigate: mockNavigate, goBack: jest.fn() };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockParams }),
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockActive,
  useAccounts: () => mockAccounts,
  useWalletSettings: () => ({}),
  useWalletStore: (selector: (state: object) => unknown) => selector({}),
}));
let mockPerNetwork: Record<string, { status: string; authAddress?: string }>;
const mockRekeyStatus = jest.fn();
jest.mock('@/store/useNetworkRekeyStatus', () => ({
  useNetworkRekeyStatus: (address: string) => {
    mockRekeyStatus(address);
    return { perNetwork: mockPerNetwork, delegatedEverywhere: false };
  },
}));
jest.mock('@/store/networkStore', () => ({
  useIsCurrentNetworkHealthy: () => true,
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { probeSecretPresenceStrict: jest.fn() },
}));
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { getMnemonic: jest.fn() },
}));
jest.mock('@/hooks/useSecureScreen', () => ({
  useSecureScreen: () => mockSecureScreen(),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/account/AccountListModal', () => () => null);
jest.mock('@/components/account/AddAccountModal', () => () => null);
jest.mock('@/components/account/RenameAccountModal', () => () => null);
jest.mock('@/components/network/NetworkIndicator', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/wallet/MnemonicDisplay', () => {
  const { Text } = require('react-native');
  return function MockMnemonicDisplay({ isBlurred }: { isBlurred: boolean }) {
    return <Text>{isBlurred ? 'phrase blurred' : 'phrase visible'}</Text>;
  };
});

const probe = jest.mocked(AccountSecureStorage.probeSecretPresenceStrict);
const note =
  "This phrase restores this account's original key. It does not recover the current signing authority on networks where the account is rekeyed.";
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
  mockActive = account();
  mockAccounts = [mockActive];
  mockParams = {};
  mockPerNetwork = {};
  mockRekeyStatus.mockReset();
  probe.mockReset();
  probe.mockResolvedValue(false);
  jest.mocked(SecureKeyManager.getMnemonic).mockResolvedValue('');
});
afterEach(() => jest.restoreAllMocks());

// originalOwner can outlive the key and a probe error is not custody, so
// only a present probe opens the phrase (TASK-425 U4; TASK-430).
it.each([
  ['owner', true, true, true],
  ['stale owner', true, false, false],
  ['owner error', true, new Error('locked'), false],
  ['present', false, true, true],
  ['absent', false, false, false],
  ['error', false, new Error('locked'), false],
] as const)(
  'Settings phrase access for REKEYED %s',
  async (_name, owner, result, available) => {
    mockActive = account({ originalOwner: owner });
    if (result instanceof Error) probe.mockRejectedValue(result);
    else probe.mockResolvedValue(result);
    const alert = jest.spyOn(Alert, 'alert');
    const view = await render(<SettingsScreen />);
    await fireEvent.press(view.getByText('Show Recovery Phrase'));
    expect(alert.mock.calls.length > 0).toBe(available);
    if (available) {
      await act(async () => alert.mock.calls[0][2]?.[1].onPress?.());
      expect(mockNavigate).toHaveBeenCalledWith('ShowRecoveryPhrase', {
        accountAddress: mockActive.address,
      });
    }
    expect(probe).toHaveBeenCalledWith(mockActive.id);
  }
);

it.each([
  [AccountType.STANDARD, true],
  [AccountType.WATCH, false],
  [AccountType.LEDGER, false],
  [AccountType.REMOTE_SIGNER, false],
])('Settings keeps %s phrase access unchanged', async (type, available) => {
  mockActive = account({ type });
  const alert = jest.spyOn(Alert, 'alert');
  const view = await render(<SettingsScreen />);
  await fireEvent.press(view.getByText('Show Recovery Phrase'));
  expect(alert.mock.calls.length > 0).toBe(available);
});

it('Settings ignores a stale key probe after switching accounts', async () => {
  let resolve!: (value: boolean) => void;
  probe.mockReturnValueOnce(new Promise((done) => (resolve = done)));
  const view = await render(<SettingsScreen />);
  mockActive = account({ id: 'keyless' });
  await view.rerender(<SettingsScreen />);
  await act(async () => resolve(true));
  const alert = jest.spyOn(Alert, 'alert');
  await fireEvent.press(view.getByText('Show Recovery Phrase'));
  expect(alert).not.toHaveBeenCalled();
});

it.each([AccountType.REKEYED, AccountType.STANDARD])(
  'reveal wording follows the targeted %s account',
  async (type) => {
    // Explicit route targets another account, independent of the active type.
    mockActive = account({
      type:
        type === AccountType.REKEYED
          ? AccountType.STANDARD
          : AccountType.REKEYED,
    });
    mockAccounts = [mockActive, account({ address: 'TARGET_ADDRESS', type })];
    mockParams = { accountAddress: 'TARGET_ADDRESS' };
    const view = await render(<ShowRecoveryPhraseScreen />);
    expect(Boolean(view.queryByText(note))).toBe(type === AccountType.REKEYED);
    expect(SecureKeyManager.getMnemonic).toHaveBeenCalledWith('TARGET_ADDRESS');
    expect(view.getByText('phrase blurred')).toBeTruthy();
    expect(mockSecureScreen).toHaveBeenCalled();
  }
);

// TASK-458: a pending rekey that lands later leaves the record STANDARD, so
// the warning follows chain state per network, not only the persisted type.
it.each([
  [
    'delegated on one network',
    { 'voi-mainnet': 'delegated', 'algorand-mainnet': 'self' },
    true,
  ],
  [
    'delegated everywhere',
    { 'voi-mainnet': 'delegated', 'algorand-mainnet': 'delegated' },
    true,
  ],
  [
    'self everywhere',
    { 'voi-mainnet': 'self', 'algorand-mainnet': 'self' },
    false,
  ],
  ['unknown (lookup failed)', { 'voi-mainnet': 'unknown' }, false],
] as const)(
  'a STANDARD record %s: warning shown = %s',
  async (_name, statuses, shown) => {
    mockActive = account({
      type: AccountType.STANDARD,
      authAddress: undefined,
    });
    mockAccounts = [mockActive];
    mockPerNetwork = Object.fromEntries(
      Object.entries(statuses).map(([network, status]) => [
        network,
        status === 'delegated'
          ? { status, authAddress: 'SIGNER_ADDRESS' }
          : { status },
      ])
    );
    const view = await render(<ShowRecoveryPhraseScreen />);
    expect(Boolean(view.queryByText(note))).toBe(shown);
    expect(mockRekeyStatus).toHaveBeenCalledWith('ORIGINAL_ADDRESS');
  }
);

it('reads chain status for the routed target, not the active account', async () => {
  mockActive = account({ type: AccountType.STANDARD });
  mockAccounts = [
    mockActive,
    account({ address: 'TARGET_ADDRESS', type: AccountType.STANDARD }),
  ];
  mockParams = { accountAddress: 'TARGET_ADDRESS' };
  await render(<ShowRecoveryPhraseScreen />);
  expect(mockRekeyStatus).toHaveBeenCalledWith('TARGET_ADDRESS');
  expect(mockRekeyStatus).not.toHaveBeenCalledWith('ORIGINAL_ADDRESS');
});

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { getRekeyStateStrict } from '@/store/walletStore';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata, AccountType } from '@/types/wallet';
import {
  VOI_CHAIN_DATA,
  ALGORAND_MAINNET_CHAIN_DATA,
} from '@/services/walletconnect/config';

const mockApprove = jest.fn();
jest.mock('@/store/walletStore', () => ({ getRekeyStateStrict: jest.fn() }));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: jest.fn() },
}));
jest.mock('@/services/walletconnect', () => ({
  ...jest.requireActual('@/services/walletconnect/config'),
  getNetworkNameByChainId: jest.requireActual('@/services/walletconnect/utils')
    .getNetworkNameByChainId,
  WalletConnectService: {
    getInstance: () => ({ approveSession: mockApprove }),
  },
}));
jest.mock('@/services/walletconnect/v1', () => ({ WalletConnectV1Client: {} }));
jest.mock('@/store/experimentalStore', () => ({
  useExperimentalStore: {
    getState: () => ({ allowUnsupportedNetworks: false }),
  },
}));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/walletconnect/AccountSelectionItem', () => {
  const { Text } = require('react-native');
  return function AccountItem({ account }: { account: AccountMetadata }) {
    return <Text>{account.label}</Text>;
  };
});
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import SessionProposalScreen from '../SessionProposalScreen';

const rekeyed = {
  id: 'rk',
  address: 'RK',
  label: 'Rekeyed',
  type: AccountType.REKEYED,
  canSign: false,
} as AccountMetadata;
const standard = {
  id: 'std',
  address: 'STD',
  label: 'Standard',
  type: AccountType.STANDARD,
} as AccountMetadata;
const proposal = {
  requiredNamespaces: {
    algorand: { chains: [VOI_CHAIN_DATA.chainId], methods: [], events: [] },
  },
  optionalNamespaces: {
    algorand: {
      chains: [ALGORAND_MAINNET_CHAIN_DATA.chainId],
      methods: [],
      events: [],
    },
  },
  proposer: { metadata: { name: 'dApp', icons: [] } },
};

it('disables approval while probing, shows partial eligibility and errors, and retries', async () => {
  jest
    .mocked(MultiAccountWalletService.getAllAccounts)
    .mockResolvedValue([rekeyed, standard]);
  let release!: (state: any) => void;
  jest
    .mocked(getRekeyStateStrict)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    )
    .mockRejectedValueOnce(new Error('offline'));
  const screen = await render(
    <SessionProposalScreen
      navigation={{} as any}
      route={{ params: { proposal } } as any}
    />
  );
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await act(async () => {
    release({ status: 'loaded', canSign: true, isRekeyed: true });
  });
  expect(screen.getByText('Only on Voi Network')).toBeTruthy();
  expect(
    screen.getByText("Couldn't check signing authority for 1 account(s)")
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  expect(screen.getByText('Rekeyed')).toBeTruthy();
  expect(screen.getByText('Standard')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  expect(mockApprove).toHaveBeenCalledWith(proposal, [rekeyed, standard]);

  jest
    .mocked(getRekeyStateStrict)
    .mockResolvedValue({ status: 'loaded', canSign: true, isRekeyed: true });
  await fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(screen.queryByText('Retry')).toBeNull());
  expect(getRekeyStateStrict).toHaveBeenCalledTimes(4);
  expect(screen.queryByText('Only on Voi Network')).toBeNull();
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
});

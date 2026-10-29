import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SecureKeyManager as Keys } from '@/services/secure/keyManager';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata, AccountType } from '@/types/wallet';
import {
  VOI_CHAIN_DATA,
  ALGORAND_MAINNET_CHAIN_DATA,
} from '@/services/walletconnect/config';

const mockApprove = jest.fn();
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { getSigningInfo: jest.fn() },
}));
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
let mockLocked = false;
let mockGrantValid = false;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      isLocked: mockLocked,
      isAuthenticated: !mockLocked,
      biometricEnabled: false,
    },
  }),
}));
jest.mock('@/services/auth/reviewGrant', () => ({
  reviewGrant: {
    subscribe: () => () => {},
    isValid: () => mockGrantValid,
    leave: jest.fn(),
    revoke: jest.fn(),
    touch: jest.fn(),
  },
  walletConnectRequestKey: (a: string, b: string | number) =>
    JSON.stringify([a, String(b)]),
}));
// The gate itself is covered by TASK-437's tests; render what it is given.
jest.mock('@/components/walletconnect/LockedRequestGate', () => {
  const { Pressable, Text } = require('react-native');
  return function Gate(props: {
    dapp?: { name?: string; url?: string };
    network: string;
    onReject: () => void;
  }) {
    return (
      <>
        <Text>Unlock to review</Text>
        <Text>{props.dapp?.name}</Text>
        <Text>{props.dapp?.url}</Text>
        <Text>{props.network}</Text>
        <Pressable onPress={props.onReject}>
          <Text>Reject</Text>
        </Pressable>
      </>
    );
  };
});
const navigationStub = () =>
  ({
    addListener: () => () => {},
    navigate: jest.fn(),
    goBack: jest.fn(),
  }) as any;

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
    .mocked(Keys.getSigningInfo)
    .mockReset()
    .mockImplementation(async (address) => ({
      canSign: true,
      signingAddress: address,
      isRekeyed: false,
    }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    )
    .mockImplementationOnce(async () => ({
      canSign: true,
      signingAddress: 'STD',
      isRekeyed: false,
    }))
    .mockRejectedValueOnce(new Error('offline'));
  const screen = await render(
    <SessionProposalScreen
      navigation={navigationStub()}
      route={{ params: { proposal } } as any}
    />
  );
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await act(async () => {
    release({ signingAddress: 'RK', canSign: true, isRekeyed: true });
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

  jest.mocked(Keys.getSigningInfo).mockResolvedValue({
    signingAddress: 'RK',
    canSign: true,
    isRekeyed: true,
  });
  await fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(screen.queryByText('Retry')).toBeNull());
  expect(Keys.getSigningInfo).toHaveBeenCalledTimes(8);
  expect(screen.queryByText('Only on Voi Network')).toBeNull();
  expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
});

const view = (params: object) => (
  <SessionProposalScreen
    navigation={navigationStub()}
    route={{ params } as any}
  />
);
const signingInfo = (canSign: boolean) => ({
  canSign,
  signingAddress: 'RK',
  isRekeyed: false,
});
it.each([true, false])(
  'keeps latest probe authoritative (older first: %s)',
  async (olderFirst) => {
    jest
      .mocked(MultiAccountWalletService.getAllAccounts)
      .mockResolvedValue([rekeyed]);
    const probe = jest
      .mocked(Keys.getSigningInfo)
      .mockReset()
      .mockRejectedValue(new Error('offline'));
    const screen = await render(view({ proposal }));
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy());
    const releases: ((value: ReturnType<typeof signingInfo>) => void)[] = [];
    probe
      .mockImplementationOnce(
        () => new Promise((resolve) => releases.push(resolve))
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => releases.push(resolve))
      )
      .mockResolvedValue(signingInfo(false));
    let node = screen.getByText('Retry');
    while (!node.props.onClick) node = node.parent!;
    await act(async () => {
      node.props.onClick();
      node.props.onClick();
    });
    expect(probe).toHaveBeenCalledTimes(3);
    await screen.rerender(view({ proposal: { ...proposal } }));
    const finish = async (index: number) =>
      act(async () => releases[index](signingInfo(index === 0)));
    await finish(olderFirst ? 0 : 1);
    if (olderFirst) {
      expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
      expect(screen.getByLabelText('Checking signing authority')).toBeTruthy();
    }
    await finish(olderFirst ? 1 : 0);
    expect(screen.queryByText('Rekeyed')).toBeNull();
    expect(screen.queryByLabelText('Checking signing authority')).toBeNull();
  }
);

// TASK-438: while the wallet is locked the connect screen shows only the gate.
// Accounts are not read, probed or mounted until the review sitting covers
// this proposal; Reject needs no auth.
describe('locked wallet (TASK-438)', () => {
  const lockedProposal = {
    ...proposal,
    id: 438,
    pairingTopic: 'pairing-438',
    proposer: {
      metadata: {
        name: 'Locked dApp',
        url: 'https://locked.example',
        description: 'A dApp-written description',
        icons: [],
      },
    },
  };

  beforeEach(() => {
    mockLocked = true;
    mockGrantValid = false;
    jest.mocked(MultiAccountWalletService.getAllAccounts).mockClear();
    jest.mocked(Keys.getSigningInfo).mockClear();
    jest
      .mocked(MultiAccountWalletService.getAllAccounts)
      .mockResolvedValue([standard]);
    jest.mocked(Keys.getSigningInfo).mockResolvedValue({
      canSign: true,
      signingAddress: 'STD',
      isRekeyed: false,
    } as never);
  });
  afterEach(() => {
    mockLocked = false;
    mockGrantValid = false;
  });

  it('shows only the gate and reads no accounts before review is unlocked', async () => {
    const navigation = navigationStub();
    const screen = await render(
      <SessionProposalScreen
        navigation={navigation}
        route={{ params: { proposal: lockedProposal } } as any}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Unlock to review')).toBeTruthy();
    expect(screen.getByText('Locked dApp')).toBeTruthy();
    expect(screen.getByText('Voi Network, Algorand Mainnet')).toBeTruthy();
    expect(screen.queryByText('Standard')).toBeNull();
    expect(screen.queryByText('A dApp-written description')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
    expect(Keys.getSigningInfo).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText('Reject'));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
  });

  it('loads and shows the accounts once the review sitting covers the proposal', async () => {
    mockGrantValid = true;
    const screen = await render(
      <SessionProposalScreen
        navigation={navigationStub()}
        route={{ params: { proposal: lockedProposal } } as any}
      />
    );

    await waitFor(() => expect(screen.getByText('Standard')).toBeTruthy());
    expect(screen.queryByText('Unlock to review')).toBeNull();
    expect(MultiAccountWalletService.getAllAccounts).toHaveBeenCalled();
  });
});

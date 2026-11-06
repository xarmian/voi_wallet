import React from 'react';
import type {
  NavigationAction,
  NavigationState,
} from '@react-navigation/native';
import { Alert, AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import {
  RequestCoordinator,
  EXIT_ANSWERS,
  type RequestRef,
  type ExitReason,
} from '@/services/walletconnect/requestCoordinator';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  proposalRefFor,
  v1ProposalRefFor,
} from '@/services/walletconnect/requestRefs';
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react-native';
import { SecureKeyManager as Keys } from '@/services/secure/keyManager';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata, AccountType } from '@/types/wallet';
import {
  VOI_CHAIN_DATA,
  ALGORAND_MAINNET_CHAIN_DATA,
} from '@/services/walletconnect/config';

const mockApprove = jest.fn();
const mockV1Approve = jest.fn();
const mockDirectReject = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));
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
    getInstance: () => ({
      approveSession: mockApprove,
      rejectSession: mockDirectReject,
    }),
  },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: {
    getInstance: () => ({
      approveSession: mockV1Approve,
      rejectSession: mockDirectReject,
    }),
  },
}));
jest.mock('@/store/experimentalStore', () => ({
  useExperimentalStore: {
    getState: () => ({ allowUnsupportedNetworks: false }),
  },
}));
jest.mock('@/components/common/UniversalHeader', () => {
  const { Pressable, Text } = require('react-native');
  return function Header({ onBackPress }: { onBackPress: () => void }) {
    return (
      <Pressable onPress={onBackPress}>
        <Text>Header back</Text>
      </Pressable>
    );
  };
});
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
  walletConnectProposalKey: (a: string, b: string | number) =>
    JSON.stringify([a, `proposal-${b}`]),
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
const navigationStub = () => {
  const listeners = new Set<() => void>();
  return {
    addListener: jest.fn((_event: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    leave: () => [...listeners].forEach((listener) => listener()),
    navigate: jest.fn(),
    goBack: jest.fn(),
    popTo: jest.fn(),
    canGoBack: () => true,
    getState: () => ({ routes: [{ key: 'proposal-route' }] }),
    dispatch: jest.fn((thunk: (state: NavigationState) => NavigationAction) => {
      const action = thunk({ key: 'proposal-stack' } as NavigationState);
      expect(action.target).toBe('proposal-stack');
      expect(action.type).toBe('POP');
      return action;
    }),
  };
};

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
  id: 518,
  pairingTopic: 'test-pairing',
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
      navigation={navigationStub() as unknown as ScreenProps['navigation']}
      route={{ key: 'proposal-route', params: { proposal } } as any}
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
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  expect(mockApprove).toHaveBeenCalledWith(proposal, [rekeyed, standard]);
});

// TASK-518: navigate('Main') pushes a second Main, so Back from Home exposed
// the already-approved Connect page. Success pops its own Connect route
// BEFORE the alert, and the alert is information only.
it('U6 pops its own Connect route before the success alert, B untouched', async () => {
  jest
    .mocked(MultiAccountWalletService.getAllAccounts)
    .mockResolvedValue([standard]);
  jest.mocked(Keys.getSigningInfo).mockResolvedValue({
    canSign: true,
    signingAddress: 'STD',
    isRekeyed: false,
  } as never);
  mockApprove.mockResolvedValue(undefined);
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const navigation = navigationStub();
  const order: string[] = [];
  navigation.dispatch.mockImplementation((thunk) => {
    const action = thunk({ key: 'proposal-stack' } as NavigationState);
    expect(action).toEqual({
      type: 'POP',
      target: 'proposal-stack',
      payload: { count: 1 },
    });
    order.push('pop');
    return action;
  });
  alertSpy.mockImplementation(() => {
    order.push('alert');
  });
  const screen = await render(
    <SessionProposalScreen
      navigation={navigation as unknown as ScreenProps['navigation']}
      route={{ key: 'proposal-route', params: { proposal } } as any}
    />
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());

  expect(navigation.dispatch).toHaveBeenCalledWith(expect.any(Function));
  expect(navigation.navigate).not.toHaveBeenCalledWith('Main');
  expect(order).toEqual(['pop', 'alert']);
  // The alert carries no navigation: nothing runs when it is acknowledged.
  const buttons = alertSpy.mock.calls[0][2];
  buttons?.forEach((button) => button.onPress?.());
  expect(navigation.navigate).not.toHaveBeenCalled();
  expect(navigation.dispatch).toHaveBeenCalledTimes(1);
  alertSpy.mockRestore();
});

const view = (params: object) => (
  <SessionProposalScreen
    navigation={navigationStub() as unknown as ScreenProps['navigation']}
    route={{ key: 'proposal-route', params } as any}
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
        navigation={navigation as unknown as ScreenProps['navigation']}
        route={
          { key: 'proposal-route', params: { proposal: lockedProposal } } as any
        }
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
    await waitFor(() => expect(navigation.dispatch).toHaveBeenCalled());
    expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
  });

  it('U7 gate lift ensures the proposal is open before loading accounts', async () => {
    const ensure = jest.spyOn(coordinator, 'ensureOpen');
    const props = {
      navigation: navigationStub() as unknown as ScreenProps['navigation'],
      route: {
        key: 'proposal-route',
        params: { proposal: lockedProposal },
      } as ScreenProps['route'],
    };
    const screen = await render(<SessionProposalScreen {...props} />);
    expect(ensure).not.toHaveBeenCalled();
    mockGrantValid = true;
    await screen.rerender(<SessionProposalScreen {...props} />);
    await waitFor(() =>
      expect(ensure).toHaveBeenCalledWith(
        proposalRefFor(lockedProposal),
        undefined
      )
    );
    await waitFor(() => expect(screen.getByText('Standard')).toBeTruthy());
  });

  it('loads and shows the accounts once the review sitting covers the proposal', async () => {
    mockGrantValid = true;
    const screen = await render(
      <SessionProposalScreen
        navigation={navigationStub() as unknown as ScreenProps['navigation']}
        route={
          { key: 'proposal-route', params: { proposal: lockedProposal } } as any
        }
      />
    );

    await waitFor(() => expect(screen.getByText('Standard')).toBeTruthy());
    expect(screen.queryByText('Unlock to review')).toBeNull();
    expect(MultiAccountWalletService.getAllAccounts).toHaveBeenCalled();
  });
});

type ScreenProps = React.ComponentProps<typeof SessionProposalScreen>;
let coordinator: RequestCoordinator;
let store: HandledStore;
let changeAppState: (state: AppStateStatus) => void;
const answers: {
  recorded: boolean;
  version: number;
  code?: number;
  message?: string;
}[] = [];
const rejectProposalV2 = jest.fn();
const rejectProposalV1 = jest.fn();
const ref = proposalRefFor(proposal);
const v1Request = {
  id: 519,
  peerId: 'test-peer',
  chainId: 4160,
  peerMeta: { name: 'v1 dApp', icons: [] },
};
const v1Ref = v1ProposalRefFor(v1Request);
const observe = async (
  requestRef: RequestRef,
  code?: number,
  message?: string
) => {
  const persisted = new HandledStore();
  await persisted.load();
  answers.push({
    recorded: persisted.isHandled(requestRef),
    version: requestRef.version,
    code,
    message,
  });
};

beforeEach(async () => {
  await AsyncStorage.clear();
  answers.length = 0;
  store = new HandledStore();
  coordinator = new RequestCoordinator({
    store,
    transport: {
      rejectRequestV2: async () => {},
      rejectRequestV1: async () => {},
      rejectProposalV2: async (id, topic, error) => {
        await observe(
          { version: 2, kind: 'proposal', id, topic },
          error.code,
          error.message
        );
        await rejectProposalV2(id, topic, error);
      },
      rejectProposalV1: async () => {
        await observe(v1Ref);
        await rejectProposalV1();
      },
    },
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  jest.spyOn(HandledStore, 'getInstance').mockReturnValue(store);
  await coordinator.admit(ref);
  await coordinator.admit(
    proposalRefFor({ ...proposal, id: 438, pairingTopic: 'pairing-438' })
  );
  await coordinator.admit(v1Ref);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      changeAppState = listener;
      return { remove: jest.fn() };
    });
  mockApprove.mockReset().mockResolvedValue(undefined);
  mockV1Approve.mockReset().mockResolvedValue(undefined);
  mockDirectReject.mockReset().mockResolvedValue(undefined);
  jest
    .mocked(MultiAccountWalletService.getAllAccounts)
    .mockResolvedValue([standard]);
  jest.mocked(Keys.getSigningInfo).mockReset().mockResolvedValue({
    canSign: true,
    signingAddress: 'STD',
    isRekeyed: false,
  });
});
afterEach(async () => {
  await cleanup();
  await act(async () => {});
  coordinator.__resetForTests();
  jest.restoreAllMocks();
});

const mountProposal = async (v1 = false, empty = false) => {
  const navigation = navigationStub();
  const screen = await render(
    <SessionProposalScreen
      navigation={navigation as unknown as ScreenProps['navigation']}
      route={
        {
          key: 'proposal-route',
          params: empty
            ? {}
            : v1
              ? { version: 1, sessionRequest: v1Request }
              : { proposal },
        } as unknown as ScreenProps['route']
      }
    />
  );
  if (!empty && !mockLocked)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    );
  return { navigation, screen };
};
const pressApprove = async (screen: Awaited<ReturnType<typeof render>>) =>
  fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
const expectAnswer = (reason: Exclude<ExitReason, 'session-ended'>) => {
  expect(answers).toEqual([
    { recorded: true, version: 2, ...EXIT_ANSWERS[reason] },
  ]);
};
const endAgain = async (
  navigation: ReturnType<typeof navigationStub>,
  screen: Awaited<ReturnType<typeof render>>,
  requestRef = ref
) => {
  await act(async () => navigation.leave());
  await screen.unmount();
  await coordinator.settle(requestRef, 'abandoned');
};

it.each([false, true])(
  'DEFECT reject records before answering once (v1: %s)',
  async (v1) => {
    const { navigation, screen } = await mountProposal(v1);
    await fireEvent.press(screen.getByText('Reject'));
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    if (v1) {
      expect(rejectProposalV1).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([{ recorded: true, version: 1 }]);
    } else {
      expect(rejectProposalV2).toHaveBeenCalledWith(
        proposal.id,
        proposal.pairingTopic,
        { code: 5000, message: 'User rejected.' }
      );
      expectAnswer('declined');
    }
    await endAgain(navigation, screen, v1 ? v1Ref : ref);
    expect(v1 ? rejectProposalV1 : rejectProposalV2).toHaveBeenCalledTimes(1);
    expect(mockDirectReject).not.toHaveBeenCalled();
  }
);

it('DEFECT locked gate rejection uses the coordinator', async () => {
  mockLocked = true;
  try {
    const { navigation, screen } = await mountProposal();
    await fireEvent.press(screen.getByText('Reject'));
    expectAnswer('declined');
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
  } finally {
    mockLocked = false;
  }
});

it('DEFECT already settled rejection still goes back exactly once', async () => {
  const { navigation, screen } = await mountProposal();
  await act(async () => {
    await coordinator.settle(ref, 'declined');
  });
  await fireEvent.press(screen.getByText('Reject'));
  expectAnswer('declined');
  expect(navigation.dispatch).toHaveBeenCalledTimes(1);
});

it.each(['header', 'beforeRemove'])(
  'DEFECT undecided %s answers abandoned once',
  async (exit) => {
    const { navigation, screen } = await mountProposal();
    if (exit === 'header')
      await fireEvent.press(screen.getByText('Header back'));
    else await act(async () => navigation.leave());
    await waitFor(() => expectAnswer('abandoned'));
    await act(async () => navigation.leave());
    await coordinator.settle(ref, 'abandoned');
    expectAnswer('abandoned');
    expect(navigation.dispatch).toHaveBeenCalledTimes(
      exit === 'header' ? 1 : 0
    );
  }
);

it('REGRESSION an unmount alone (an effect replay) never declines the request', async () => {
  const { screen } = await mountProposal();
  await screen.unmount();
  expect(answers).toEqual([]);
  expect(coordinator.isOpen(ref)).toBe(true);
});

it.each([false, true])(
  'DEFECT approval is durable before publish and beforeRemove does not settle (v1: %s)',
  async (v1) => {
    const { navigation, screen } = await mountProposal(v1);
    const recorded: boolean[] = [];
    const approve = v1 ? mockV1Approve : mockApprove;
    approve.mockImplementation(async () => {
      const persisted = new HandledStore();
      await persisted.load();
      recorded.push(persisted.isHandled(v1 ? v1Ref : ref));
    });
    const settle = jest.spyOn(coordinator, 'settle');
    navigation.dispatch.mockImplementation((thunk) => {
      navigation.leave();
      return thunk({ key: 'proposal-stack' } as NavigationState);
    });
    await pressApprove(screen);
    expect(recorded).toEqual([true]);
    expect(navigation.dispatch).toHaveBeenCalledWith(expect.any(Function));
    expect(navigation.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(Alert.alert).mock.invocationCallOrder[0]
    );
    expect(settle).not.toHaveBeenCalled();
    await screen.unmount();
    expect(settle).not.toHaveBeenCalled();
    expect(answers).toEqual([]);
  }
);

it('DEFECT approval of a ref already closed by expiry never publishes', async () => {
  // Isolate decide(false) from the external expiry listener. Admission must
  // finish while open; a proposal closed before mount now leaves on admission.
  jest.spyOn(coordinator, 'subscribe').mockReturnValue(() => {});
  const { navigation, screen } = await mountProposal();
  await coordinator.settle(ref, 'expired');
  await pressApprove(screen);
  expect(mockApprove).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(
    'Request ended',
    'Request expired. Try again in the dApp.'
  );
  expect(navigation.dispatch).toHaveBeenCalledTimes(1);
  await endAgain(navigation, screen);
  expectAnswer('expired');
});

it('DEFECT failed decision write leaves approval retryable', async () => {
  const { navigation, screen } = await mountProposal();
  jest
    .mocked(AsyncStorage.setItem)
    .mockRejectedValueOnce(new Error('storage unavailable'));
  await pressApprove(screen);
  expect(mockApprove).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(
    'Error',
    'Could not record your approval. Try again.'
  );
  expect(navigation.dispatch).not.toHaveBeenCalled();
  expect(coordinator.isOpen(ref)).toBe(true);
  expect(store.isHandled(ref)).toBe(false);
  await pressApprove(screen);
  expect(mockApprove).toHaveBeenCalledTimes(1);
  expect(navigation.dispatch).toHaveBeenCalledWith(expect.any(Function));
  expect(answers).toEqual([]);
});

it.each([false, true])(
  'DEFECT approval failures answer once and close (v1: %s)',
  async (v1) => {
    const { navigation, screen } = await mountProposal(v1);
    (v1 ? mockV1Approve : mockApprove).mockRejectedValue(
      new Error('No signable accounts available')
    );
    await pressApprove(screen);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      'No signable accounts available'
    );
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    if (v1) expect(answers).toEqual([{ recorded: true, version: 1 }]);
    else expectAnswer('unsupported-accounts');
    await endAgain(navigation, screen, v1 ? v1Ref : ref);
    expect(v1 ? rejectProposalV1 : rejectProposalV2).toHaveBeenCalledTimes(1);
  }
);

it.each([
  ['relay unavailable', 'load-failed'],
  ['This dApp requires a network this wallet does not support.', null],
] as const)(
  'DEFECT approval throw %s closes with correct answer',
  async (message, reason) => {
    const { navigation, screen } = await mountProposal();
    mockApprove.mockRejectedValue(new Error(message));
    await pressApprove(screen);
    expect(Alert.alert).toHaveBeenCalledWith('Error', message);
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    await endAgain(navigation, screen);
    if (reason) expectAnswer(reason);
    else expect(answers).toEqual([]);
  }
);

it('DEFECT background closes and toasts once; inactive keeps request open', async () => {
  const { navigation, screen } = await mountProposal();
  await act(async () => changeAppState('inactive'));
  expect(answers).toEqual([]);
  expect(coordinator.isOpen(ref)).toBe(true);
  expect(navigation.dispatch).not.toHaveBeenCalled();
  await act(async () => changeAppState('background'));
  await waitFor(() => expectAnswer('background'));
  expect(navigation.dispatch).toHaveBeenCalledTimes(1);
  expect(Toast.show).toHaveBeenCalledWith({
    type: 'info',
    text1: 'Request closed',
    text2: 'Try again in the dApp.',
  });
  await endAgain(navigation, screen);
  expectAnswer('background');
});

it('DEFECT account load failure answers load-failed and closes', async () => {
  jest
    .mocked(MultiAccountWalletService.getAllAccounts)
    .mockRejectedValue(new Error('offline'));
  const navigation = navigationStub();
  const screen = await render(
    <SessionProposalScreen
      navigation={navigation as unknown as ScreenProps['navigation']}
      route={
        {
          key: 'proposal-route',
          params: { proposal },
        } as unknown as ScreenProps['route']
      }
    />
  );
  await waitFor(() => expect(navigation.dispatch).toHaveBeenCalledTimes(1));
  expect(Alert.alert).toHaveBeenCalledWith('Error', 'Failed to load accounts');
  await waitFor(() => expectAnswer('load-failed'));
  await endAgain(navigation, screen);
  expectAnswer('load-failed');
});

it.each(['expired', 'session-ended'] as const)(
  'DEFECT coordinator %s closes shown proposal once',
  async (reason) => {
    const { navigation, screen } = await mountProposal();
    await act(async () => {
      await coordinator.settle(ref, reason);
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      'Request ended',
      reason === 'expired'
        ? 'Request expired. Try again in the dApp.'
        : 'Connection ended. Reconnect in the dApp.'
    );
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    await endAgain(navigation, screen);
    if (reason === 'expired') expectAnswer('expired');
    else expect(answers).toEqual([]);
  }
);

it('REGRESSION missing proposal has no answer on any exit', async () => {
  const { navigation, screen } = await mountProposal(false, true);
  await fireEvent.press(screen.getByText('Header back'));
  await act(async () => changeAppState('background'));
  await act(async () => navigation.leave());
  await screen.unmount();
  expect(answers).toEqual([]);
  expect(navigation.dispatch).toHaveBeenCalledTimes(1);
});

it('REGRESSION equivalent proposal route params keep the request open', async () => {
  const { navigation, screen } = await mountProposal();
  await screen.rerender(
    <SessionProposalScreen
      navigation={navigation as unknown as ScreenProps['navigation']}
      route={
        {
          key: 'proposal-route',
          params: { proposal: { ...proposal } },
        } as unknown as ScreenProps['route']
      }
    />
  );
  expect(coordinator.isOpen(ref)).toBe(true);
  expect(answers).toEqual([]);
});

it('REGRESSION any coordinator closure owns subsequent removal', async () => {
  const { navigation, screen } = await mountProposal();
  await act(async () => {
    await coordinator.settle(ref, 'load-failed');
  });
  const settle = jest.spyOn(coordinator, 'settle');
  await act(async () => navigation.leave());
  await screen.unmount();
  expect(settle).not.toHaveBeenCalled();
  expectAnswer('load-failed');
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(navigation.dispatch).not.toHaveBeenCalled();
});

it.each([false, true])(
  'DEFECT scoped pop failure after successful approval sends no failure or back (v1: %s)',
  async (v1) => {
    const { navigation, screen } = await mountProposal(v1);
    navigation.dispatch.mockImplementationOnce(() => {
      throw new Error('navigation failed');
    });
    await pressApprove(screen);
    expect(v1 ? mockV1Approve : mockApprove).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith('Error', 'navigation failed');
    expect(answers).toEqual([]);
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
  }
);

it.each(['expired', 'handled', 'unavailable'] as const)(
  'U6 proposal admission %s leaves before loading accounts',
  async (ending) => {
    jest.spyOn(coordinator, 'ensureOpen').mockResolvedValueOnce(ending);
    jest.mocked(MultiAccountWalletService.getAllAccounts).mockClear();
    const navigation = navigationStub();
    await render(
      <SessionProposalScreen
        navigation={navigation as unknown as ScreenProps['navigation']}
        route={
          {
            key: 'proposal-route',
            params: { proposal },
          } as unknown as ScreenProps['route']
        }
      />
    );
    await waitFor(() => expect(navigation.dispatch).toHaveBeenCalledTimes(1));
    expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
    if (ending === 'unavailable') expect(Toast.show).not.toHaveBeenCalled();
    else
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'info',
        text1:
          ending === 'expired' ? 'Request expired' : 'Request already handled',
        text2:
          ending === 'expired'
            ? 'Try again in the dApp.'
            : 'Check the dApp before you try again.',
      });
  }
);

it('U6 expired proposal delivered after its deadline never reads accounts', async () => {
  const navigation = navigationStub();
  const late = {
    ...proposal,
    id: 600,
    expiryTimestamp: Math.floor(Date.now() / 1000) - 1,
  };
  jest.mocked(MultiAccountWalletService.getAllAccounts).mockClear();
  await render(
    <SessionProposalScreen
      navigation={navigation as unknown as ScreenProps['navigation']}
      route={
        {
          key: 'proposal-route',
          params: { proposal: late },
        } as unknown as ScreenProps['route']
      }
    />
  );
  await waitFor(() => expect(navigation.dispatch).toHaveBeenCalledTimes(1));
  expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
  expect(Toast.show).toHaveBeenCalledWith({
    type: 'info',
    text1: 'Request expired',
    text2: 'Try again in the dApp.',
  });
});

it.each(['background', 'second tap'] as const)(
  'U6 proposal approval in flight ignores %s',
  async (event) => {
    const { screen, navigation } = await mountProposal();
    let finish!: (won: boolean) => void;
    const decide = jest.spyOn(coordinator, 'decide').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    let button = screen.getByRole('button', { name: 'Connect' });
    while (!button.props.onClick) button = button.parent!;
    const approve = button.props.onClick as () => void;
    await act(async () => {
      approve();
      if (event === 'second tap') approve();
    });
    if (event === 'background')
      await act(async () => changeAppState('background'));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([]);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(navigation.dispatch).not.toHaveBeenCalled();
    await act(async () => {
      finish(true);
    });
    expect(mockApprove).toHaveBeenCalledTimes(1);
  }
);

// The route screen scopes its navigation to its own route: once that route is
// gone, leaving through the header dispatches nothing.
it('scopes its navigation to the screen route key', async () => {
  jest.mocked(MultiAccountWalletService.getAllAccounts).mockResolvedValue([]);
  const navigation = navigationStub();
  navigation.getState = () => ({ routes: [] });
  const screen = await render(
    <SessionProposalScreen
      navigation={navigation as unknown as ScreenProps['navigation']}
      route={{ key: 'proposal-route', params: { proposal } } as any}
    />
  );
  await fireEvent.press(screen.getByText('Header back'));
  expect(navigation.dispatch).not.toHaveBeenCalled();
});

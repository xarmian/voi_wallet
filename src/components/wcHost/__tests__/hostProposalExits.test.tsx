import React from 'react';
import { Alert, AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RequestCoordinator } from '@/services/walletconnect/requestCoordinator';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  proposalRefFor,
  v1ProposalRefFor,
} from '@/services/walletconnect/requestRefs';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SecureKeyManager as Keys } from '@/services/secure/keyManager';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { VOI_CHAIN_DATA } from '@/services/walletconnect/config';

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
    return <Text>{account.address}</Text>;
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
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      authChecked: true,
      securityUnavailable: false,
      hasPin: true,
      pinSetupResume: false,
      isLocked: mockLocked,
      isAuthenticated: !mockLocked,
      biometricEnabled: false,
    },
  }),
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

import { ConnectReview } from '@/screens/walletconnect/SessionProposalScreen';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { getHeadSession } from '../headSession';
import WalletConnectHost from '../WalletConnectHost';
import {
  reviewGrant,
  walletConnectProposalKey,
} from '@/services/auth/reviewGrant';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
const proposal = {
  id: 518,
  pairingTopic: 'fixture-pairing',
  requiredNamespaces: {
    algorand: { chains: [VOI_CHAIN_DATA.chainId], methods: [], events: [] },
  },
  proposer: {
    metadata: {
      name: 'fixture dApp',
      url: 'https://fixture.example',
      icons: [],
    },
  },
};
const account = {
  id: 'fixture-account',
  address: 'PRIVATE_ACCOUNT_ADDRESS',
  label: 'fixture account',
  type: AccountType.STANDARD,
} as AccountMetadata;
const ref = proposalRefFor(proposal);
let queue: RequestQueue;
let coordinator: RequestCoordinator;
let session: ReturnType<typeof getHeadSession>;
let changeState: (state: AppStateStatus) => void;
let params: { proposal: typeof proposal | undefined };
beforeEach(async () => {
  mockLocked = false;
  reviewGrant.revoke(false);
  AppLockSignal.setUnlocked(true);
  SessionKeyVault.set('fixture', 'pin');
  jest.spyOn(reviewGrant, 'leave');
  await AsyncStorage.clear();
  const store = new HandledStore();
  coordinator = new RequestCoordinator({
    store,
    transport: {
      rejectRequestV1: async () => {},
      rejectRequestV2: async () => {},
      rejectProposalV1: async () => {},
      rejectProposalV2: async () => {},
    },
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  await coordinator.admit(ref);
  queue = new RequestQueue({
    coordinator,
    describeClose: (reason) => ({ title: reason }),
  });
  queue.push({ ref, payload: proposal, firstSeenMs: Date.now() });
  jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
  session = getHeadSession(queue.getSnapshot().head!, { queue, coordinator });
  params = { proposal };
  jest
    .mocked(MultiAccountWalletService.getAllAccounts)
    .mockResolvedValue([account]);
  jest.mocked(Keys.getSigningInfo).mockResolvedValue({
    canSign: true,
    signingAddress: account.address,
    isRekeyed: false,
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      changeState = listener;
      return { remove: jest.fn() };
    });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockApprove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  queue.__resetForTests();
  coordinator.__resetForTests();
  reviewGrant.revoke(false);
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);
  jest.restoreAllMocks();
});
const body = () => <ConnectReview params={params} binding={session.binding} />;
async function mount() {
  const view = await render(body());
  if (!mockLocked && params.proposal)
    await waitFor(() =>
      expect(view.getByRole('button', { name: 'Connect' })).toBeEnabled()
    );
  return view;
}
const approve = async (view: Awaited<ReturnType<typeof render>>) =>
  fireEvent.press(view.getByRole('button', { name: 'Connect' }));

it('DEFECT approve finishes the head and ignores Main (behaviour question for product at cutover)', async () => {
  const view = await mount();
  const decide = jest.spyOn(coordinator, 'decide');
  const settle = jest.spyOn(coordinator, 'settle');
  await approve(view);
  expect(decide).toHaveBeenCalledWith(ref, 'approved');
  expect(session.lastReason).toBeUndefined();
  expect(mockApprove).toHaveBeenCalledWith(proposal, [account]);
  expect(settle).not.toHaveBeenCalled();
  expect(queue.getSnapshot().result).toMatchObject({
    title: 'Success',
    message: 'Successfully connected to dApp',
  });
});
it('DEFECT reject settles declined and finishes once', async () => {
  const view = await mount();
  const settle = jest.spyOn(coordinator, 'settle');
  await fireEvent.press(view.getByText('Reject'));
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(ref, 'declined');
  expect(queue.getSnapshot().result?.title).toBe('declined');
  expect(session.lastReason).toBe('declined');
});
it('DEFECT header back settles abandoned and finishes once', async () => {
  const view = await mount();
  const settle = jest.spyOn(coordinator, 'settle');
  await fireEvent.press(view.getByText('Header back'));
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(ref, 'abandoned');
  expect(queue.getSnapshot().result?.title).toBe('abandoned');
  expect(session.lastReason).toBe('abandoned');
});
it('DEFECT beforeRemove equivalent: onLeave at real finish abandons once', async () => {
  await mount();
  const settle = jest.spyOn(coordinator, 'settle');
  await act(async () => {
    session.binding.nav.goBack();
  });
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(ref, 'abandoned');
  expect(queue.getSnapshot().result?.title).toBe('abandoned');
  expect(session.lastReason).toBeUndefined();
});
it('DEFECT background closes; inactive keeps the head', async () => {
  await mount();
  const settle = jest.spyOn(coordinator, 'settle');
  await act(async () => changeState('inactive'));
  expect(queue.getSnapshot().head).not.toBeNull();
  await act(async () => changeState('background'));
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(ref, 'background');
  expect(queue.getSnapshot().result?.title).toBe('background');
});
it.each(['expired', 'session-ended'] as const)(
  'DEFECT %s external close has the route coordinator-call count',
  async (reason) => {
    await mount();
    const settle = jest.spyOn(coordinator, 'settle');
    await act(async () => {
      await coordinator.settle(ref, reason);
    });
    expect(queue.getSnapshot().result?.title).toBe(reason);
    expect(settle).toHaveBeenCalledTimes(1);
  }
);
it.each(['handled', 'unavailable'] as const)(
  'DEFECT %s admission closes without reading accounts',
  async (state) => {
    jest.spyOn(coordinator, 'ensureOpen').mockResolvedValueOnce(state);
    jest.mocked(MultiAccountWalletService.getAllAccounts).mockClear();
    await render(body());
    await waitFor(() => expect(queue.getSnapshot().head).toBeNull());
    expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
  }
);
it('REGRESSION missing proposal never settles on any exit', async () => {
  params = { proposal: undefined };
  const settle = jest.spyOn(coordinator, 'settle');
  const view = await mount();
  await fireEvent.press(view.getByText('Header back'));
  expect(settle).not.toHaveBeenCalled();
  expect(queue.getSnapshot().result).not.toBeNull();
});
it('REGRESSION equivalent params replay keeps the same binding and head', async () => {
  const view = await mount();
  const settle = jest.spyOn(coordinator, 'settle');
  params = { proposal: { ...proposal } };
  await view.rerender(body());
  expect(settle).not.toHaveBeenCalled();
  expect(queue.getSnapshot().head?.ref).toEqual(ref);
});
it('REGRESSION coordinator closure owns subsequent removal', async () => {
  const view = await mount();
  await act(async () => {
    await coordinator.settle(ref, 'load-failed');
  });
  const settle = jest.spyOn(coordinator, 'settle');
  session.end();
  await view.unmount();
  expect(settle).not.toHaveBeenCalled();
  expect(queue.getSnapshot().result?.title).toBe('load-failed');
});
it('DEFECT load failure settles load-failed and finishes', async () => {
  jest
    .mocked(MultiAccountWalletService.getAllAccounts)
    .mockRejectedValueOnce(new Error('offline'));
  const settle = jest.spyOn(coordinator, 'settle');
  await render(body());
  await waitFor(() => expect(queue.getSnapshot().head).toBeNull());
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(ref, 'load-failed');
  expect(queue.getSnapshot().result?.title).toBe('load-failed');
});
it('DEFECT second tap during approval decides once', async () => {
  const view = await mount();
  let finish!: (won: boolean) => void;
  const decide = jest.spyOn(coordinator, 'decide').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  let button = view.getByRole('button', { name: 'Connect' });
  while (!button.props.onClick) button = button.parent!;
  await act(async () => {
    button.props.onClick();
    button.props.onClick();
  });
  expect(decide).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(true);
  });
  expect(mockApprove).toHaveBeenCalledTimes(1);
  expect(queue.getSnapshot().result).not.toBeNull();
});
it('DEFECT locked gate rejection needs no account reads', async () => {
  mockLocked = true;
  jest.mocked(MultiAccountWalletService.getAllAccounts).mockClear();
  const view = await mount();
  const settle = jest.spyOn(coordinator, 'settle');
  await fireEvent.press(view.getByText('Reject'));
  expect(settle).toHaveBeenCalledWith(ref, 'declined');
  expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
  expect(queue.getSnapshot().result?.title).toBe('declined');
  expect(session.lastReason).toBe('declined');
});
it('DEFECT already settled rejection keeps the first result', async () => {
  const view = await mount();
  await act(async () => {
    await coordinator.settle(ref, 'declined');
  });
  const result = queue.getSnapshot().result;
  await fireEvent.press(view.getByText('Reject'));
  expect(queue.getSnapshot().result).toBe(result);
});
it('DEFECT decision write failure keeps approval retryable', async () => {
  const view = await mount();
  jest
    .mocked(AsyncStorage.setItem)
    .mockRejectedValueOnce(new Error('fixture storage failure'));
  await approve(view);
  expect(queue.getSnapshot().head).not.toBeNull();
  expect(mockApprove).not.toHaveBeenCalled();
  await approve(view);
  expect(mockApprove).toHaveBeenCalledTimes(1);
  expect(queue.getSnapshot().head).toBeNull();
});

it('DEFECT proposal real body active lock without grant hides seeded account from text and labels', async () => {
  const view = await render(<WalletConnectHost />);
  await waitFor(() => expect(view.getByText(account.address)).toBeTruthy());
  mockLocked = true;
  await view.rerender(<WalletConnectHost />);
  expect(JSON.stringify(view.toJSON())).not.toContain(account.address);
});
it('DEFECT proposal real lock (AppLockSignal) revokes a valid grant and hides the seeded account from text', async () => {
  const requestKey = walletConnectProposalKey(
    proposal.pairingTopic,
    proposal.id
  );
  reviewGrant.mintForWaiting([requestKey]);
  const view = await render(<WalletConnectHost />);
  await waitFor(() => expect(view.getByText(account.address)).toBeTruthy());
  AppLockSignal.setUnlocked(false);
  mockLocked = true;
  await view.rerender(<WalletConnectHost />);
  expect(reviewGrant.isValid(requestKey)).toBe(false);
  expect(JSON.stringify(view.toJSON())).not.toContain(account.address);
});

// Dropped by the dev lead as unreachable: a grant that survives the lock. A real
// lock revokes it (the real-lock test above), and the cover and the lock signal
// come from the same AuthContext state; lockCoverCondition.test.ts pins both.

it('DEFECT proposal before signer survives active lock/unlock then reaches the real coordinator decide path', async () => {
  const view = await render(<WalletConnectHost />);
  await waitFor(() => expect(view.getByText(account.address)).toBeTruthy());
  const settle = jest.spyOn(coordinator, 'settle');
  const decide = jest.spyOn(coordinator, 'decide');
  const leave = jest.fn();
  session.binding.onLeave(leave);
  const binding = session.binding;
  mockLocked = true;
  await view.rerender(<WalletConnectHost />);
  mockLocked = false;
  await view.rerender(<WalletConnectHost />);
  await waitFor(() =>
    expect(view.getByRole('button', { name: 'Connect' })).toBeEnabled()
  );
  expect(getHeadSession(session.item, { queue, coordinator })).toBe(session);
  expect(session.binding).toBe(binding);
  expect(settle).not.toHaveBeenCalled();
  expect(reviewGrant.leave).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
  await approve(view);
  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledWith(ref, 'approved');
  expect(session.lastReason).toBeUndefined();
  expect(mockApprove).toHaveBeenCalledTimes(1);
});

it.each([
  ['No signable accounts available', 'unsupported-accounts'],
  ['relay unavailable', 'load-failed'],
  ['This dApp requires a network this wallet does not support.', null],
] as const)(
  'DEFECT approval failure %s preserves the route answer and finishes',
  async (message, reason) => {
    const view = await mount();
    const sendError = jest.spyOn(coordinator, 'sendError');
    mockApprove.mockRejectedValueOnce(new Error(message));
    await approve(view);
    if (reason) expect(sendError).toHaveBeenCalledWith(ref, reason);
    else expect(sendError).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Error', message);
    expect(queue.getSnapshot().head).toBeNull();
  }
);
it('DEFECT approval in flight ignores background', async () => {
  const view = await mount();
  let finish!: (won: boolean) => void;
  const decide = jest.spyOn(coordinator, 'decide').mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      })
  );
  const settle = jest.spyOn(coordinator, 'settle');
  let button = view.getByRole('button', { name: 'Connect' });
  while (!button.props.onClick) button = button.parent!;
  await act(async () => {
    button.props.onClick();
  });
  await act(async () => changeState('background'));
  expect(settle).not.toHaveBeenCalled();
  expect(queue.getSnapshot().head).not.toBeNull();
  expect(decide).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(true);
  });
  expect(mockApprove).toHaveBeenCalledTimes(1);
});
it('DEFECT expired admission finishes before loading accounts', async () => {
  jest.spyOn(coordinator, 'ensureOpen').mockResolvedValueOnce('expired');
  jest.mocked(MultiAccountWalletService.getAllAccounts).mockClear();
  await render(body());
  await waitFor(() => expect(queue.getSnapshot().head).toBeNull());
  expect(MultiAccountWalletService.getAllAccounts).not.toHaveBeenCalled();
});
it('DEFECT expired coordinator head disappears before another approval can publish', async () => {
  const view = await render(<WalletConnectHost />);
  await waitFor(() =>
    expect(view.getByRole('button', { name: 'Connect' })).toBeEnabled()
  );
  await act(async () => {
    await coordinator.settle(ref, 'expired');
  });
  expect(view.queryByRole('button', { name: 'Connect' })).toBeNull();
  expect(mockApprove).not.toHaveBeenCalled();
  expect(queue.getSnapshot().result?.title).toBe('expired');
});

it.each(['approve', 'reject', 'approval failure'] as const)(
  'DEFECT v1 host proposal %s preserves coordinator ownership and finishes',
  async (exit) => {
    queue.__resetForTests();
    const sessionRequest = {
      id: 519,
      peerId: 'fixture-peer',
      chainId: 4160,
      peerMeta: { name: 'fixture v1 dApp', icons: [] },
    };
    const v1Ref = v1ProposalRefFor(sessionRequest);
    await coordinator.admit(v1Ref);
    queue.push({
      ref: v1Ref,
      payload: sessionRequest,
      firstSeenMs: Date.now(),
    });
    mockV1Approve.mockReset().mockResolvedValue(undefined);
    if (exit === 'approval failure')
      mockV1Approve.mockRejectedValueOnce(
        new Error('No signable accounts available')
      );
    const view = await render(<WalletConnectHost />);
    await waitFor(() =>
      expect(view.getByRole('button', { name: 'Connect' })).toBeEnabled()
    );
    const settle = jest.spyOn(coordinator, 'settle');
    const decide = jest.spyOn(coordinator, 'decide');
    if (exit === 'reject') {
      await fireEvent.press(view.getByText('Reject'));
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(v1Ref, 'declined');
      expect(decide).not.toHaveBeenCalled();
    } else {
      await approve(view);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith(v1Ref, 'approved');
      expect(mockV1Approve).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
    }
    expect(queue.getSnapshot().head).toBeNull();
    expect(queue.getSnapshot().result?.ref).toEqual(v1Ref);
  }
);

import React from 'react';
import { Alert, Text as MockText, View as MockView } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import NewMessageScreen from '../NewMessageScreen';
import ChatScreen from '../ChatScreen';
import MessagesInboxScreen from '../MessagesInboxScreen';
import { getRekeyStateStrict } from '@/store/walletStore';
import { AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

const {
  STANDARD: S,
  REKEYED: R,
  LEDGER: L,
  WATCH: W,
  REMOTE_SIGNER: Q,
} = AccountType;
const source = () => ({
  id: 'source',
  address: 'SOURCE',
  type: R,
  authAddress: 'STALE',
  canSign: true,
});
const auth = () => ({ ...source(), id: 'auth', address: 'CHAIN', type: S });
let mockAccount = source();
let mockAccounts = [mockAccount, auth()];
let mockFocused = true;
const mockFocusListeners = new Set<() => void>();
async function focus(value: boolean) {
  await act(async () => {
    mockFocused = value;
    mockFocusListeners.forEach((listener) => listener());
  });
}
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() };
const mockMessages = {
  isInitialized: true,
  isKeyRegistered: true,
  hiddenThreads: new Set(),
  checkKeyRegistration: jest.fn(async () => true),
  fetchAllThreads: jest.fn(),
  fetchThreadMessages: jest.fn(),
  markThreadAsRead: jest.fn(),
  startPolling: jest.fn(),
  stopPolling: jest.fn(),
};
const mockFriends = {
  friends: [{ address: 'FRIEND', envoiName: 'Friend' }],
  isInitialized: true,
};
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { probeSecretPresenceStrict: jest.fn() },
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockAccount,
  useAccounts: () => mockAccounts,
  getRekeyStateStrict: jest.fn(),
}));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () =>
    require('@/types/network').NetworkId.ALGORAND_MAINNET,
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { friendAddress: 'FRIEND' } }),
  useFocusEffect: (callback: () => void) => {
    const React = require('react');
    const focused = React.useSyncExternalStore(
      (listener: () => void) => {
        mockFocusListeners.add(listener);
        return () => mockFocusListeners.delete(listener);
      },
      () => mockFocused
    );
    React.useEffect(
      () => (focused ? callback() : undefined),
      [callback, focused]
    );
  },
}));
jest.mock('@/store/messagesStore', () => ({
  useMessagesStore: () => mockMessages,
  useThread: () => undefined,
  useSortedThreads: () => [],
  useHiddenThreadsCount: () => 0,
  useShowHiddenThreads: () => false,
}));
jest.mock('@/store/friendsStore', () => ({
  useFriendsStore: (select: (state: unknown) => unknown) => select(mockFriends),
}));
jest.mock('@/store/experimentalStore', () => ({
  useIsMessagingEnabled: () => true,
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/utils/address', () => ({
  formatAddress: (address: string) => address,
}));
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => () => null);
jest.mock('@/services/envoi', () => ({}));
jest.mock('@/services/messaging', () => ({
  isMessagingKeyRegistered: async () => true,
}));
jest.mock('@/components/account/AccountAvatar', () => () => null);
jest.mock('@/components/account/AccountListModal', () => () => null);
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/social/MessagingInfoModal', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => (
    <MockView>{children}</MockView>
  ),
}));
jest.mock('@/components/common/BlurredContainer', () => ({
  BlurredContainer: ({ children }: { children: React.ReactNode }) => (
    <MockView>{children}</MockView>
  ),
}));
jest.mock('@/components/social/MessageInput', () => ({
  __esModule: true,
  default: ({ disabled }: { disabled: boolean }) => (
    <MockText>{disabled ? 'send-disabled' : 'send-enabled'}</MockText>
  ),
}));
jest.mock('@/components/common/GlassButton', () => ({
  GlassButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled: boolean;
    onPress: () => void;
  }) => (
    <MockText onPress={onPress} disabled={disabled}>
      {label}:{String(disabled)}
    </MockText>
  ),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const probe = jest.mocked(getRekeyStateStrict);
const secret = jest.mocked(AccountSecureStorage.probeSecretPresenceStrict);
const explanation =
  'Encrypted messaging requires this account’s secret key and a held software signing key on Voi.';
const errorText = 'Unable to verify messaging signer. Please try again.';
beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  mockAccount = source();
  mockAccounts = [mockAccount, auth()];
  mockMessages.isKeyRegistered = true;
  secret.mockResolvedValue(true);
  probe.mockResolvedValue({
    status: 'loaded',
    isRekeyed: false,
    canSign: false,
  });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function assertCapability(
  view: Awaited<ReturnType<typeof render>>,
  Screen: typeof ChatScreen,
  allowed: boolean
) {
  if (Screen === ChatScreen)
    expect(
      view.getByText(allowed ? 'send-enabled' : 'send-disabled')
    ).toBeTruthy();
  if (Screen === NewMessageScreen)
    view
      .getAllByText('Friend')
      .forEach((item) =>
        allowed ? expect(item).toBeEnabled() : expect(item).toBeDisabled()
      );
  if (Screen === MessagesInboxScreen) {
    if (allowed) expect(view.getByText('No messages yet')).toBeTruthy();
    else expect(view.queryByText('No messages yet')).toBeNull();
  }
}

describe.each([NewMessageScreen, ChatScreen, MessagesInboxScreen])(
  '%p',
  (Screen) => {
    it.each([
      ['direct STANDARD', S, false, undefined, true, false],
      ['direct LEDGER', L, false, undefined, false, true],
      ['direct REMOTE_SIGNER', Q, false, undefined, false, false],
      ['direct WATCH', W, false, undefined, false, false],
      ['rekeyed to held STANDARD', R, true, S, true, false],
      // TASK-425 U3: a retained REKEYED auth key signs too.
      ['rekeyed to a retained REKEYED key', R, true, R, true, false],
      ['rekeyed to LEDGER', R, true, L, false, true],
      ['retained key, unrekeyed on Voi', R, false, undefined, true, false],
      ['rekeyed to missing key', R, true, undefined, false, false],
      ['LEDGER source rekeyed to held STANDARD', L, true, S, false, false],
    ])('%s', async (_name, type, isRekeyed, authType, allowed, ledger) => {
      mockAccount.type = type;
      mockAccounts = [mockAccount];
      if (authType) mockAccounts.push({ ...auth(), type: authType });
      probe.mockResolvedValue({
        status: 'loaded',
        isRekeyed,
        authAddress: isRekeyed ? 'CHAIN' : undefined,
        canSign: false,
      });
      const view = await render(<Screen />);
      expect(probe).toHaveBeenCalledWith('SOURCE', NetworkId.VOI_MAINNET);
      assertCapability(view, Screen, allowed);
      if (!allowed && !ledger) expect(view.getByText(explanation)).toBeTruthy();
      if (ledger && Screen === MessagesInboxScreen)
        expect(view.getByText('Ledger Not Supported')).toBeTruthy();
      if (ledger && Screen === NewMessageScreen)
        expect(Alert.alert).toHaveBeenCalledWith(
          'Ledger Not Supported',
          expect.any(String),
          expect.any(Array)
        );
      if (allowed) expect(secret).toHaveBeenCalledWith('source');
    });

    it('requires the retained REKEYED auth key to be present', async () => {
      mockAccount.type = R;
      mockAccounts = [mockAccount, { ...auth(), type: R }];
      secret.mockImplementation(async (id) => id !== 'auth');
      probe.mockResolvedValue({
        status: 'loaded',
        isRekeyed: true,
        authAddress: 'CHAIN',
        canSign: true,
      });
      const view = await render(<Screen />);
      assertCapability(view, Screen, false);
      expect(view.getByText(explanation)).toBeTruthy();
    });

    it.each(['source', 'auth'])(
      'requires the %s secret even with STANDARD authority',
      async (missing) => {
        secret.mockImplementation(async (id) => id !== missing);
        probe.mockResolvedValue({
          status: 'loaded',
          isRekeyed: true,
          authAddress: 'CHAIN',
          canSign: true,
        });
        const view = await render(<Screen />);
        assertCapability(view, Screen, false);
        expect(view.getByText(explanation)).toBeTruthy();
      }
    );

    it('disables pending; refocus probes again; balance replacements do not probe', async () => {
      let resolve!: (
        state: Awaited<ReturnType<typeof getRekeyStateStrict>>
      ) => void;
      probe.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        })
      );
      const view = await render(<Screen />);
      assertCapability(view, Screen, false);
      await act(async () =>
        resolve({ status: 'loaded', isRekeyed: false, canSign: false })
      );
      assertCapability(view, Screen, true);
      const count = probe.mock.calls.length;
      const secrets = secret.mock.calls.length;
      mockAccounts = mockAccounts.map((account) => ({ ...account }));
      mockAccount = { ...mockAccount };
      await view.rerender(<Screen />);
      expect(probe).toHaveBeenCalledTimes(count);
      expect(secret).toHaveBeenCalledTimes(secrets);
      assertCapability(view, Screen, true);
      await focus(false);
      await focus(true);
      expect(probe).toHaveBeenCalledTimes(count + 1);
      assertCapability(view, Screen, true);
      expect(Alert.alert).not.toHaveBeenCalled();
    });

    it.each(['chain', 'secret'])(
      '%s error shows inline Retry and recovers without alerts',
      async (failure) => {
        if (failure === 'chain')
          probe.mockRejectedValueOnce(new Error('offline'));
        else secret.mockRejectedValueOnce(new Error('keychain unavailable'));
        const view = await render(<Screen />);
        expect(view.getByText(errorText)).toBeTruthy();
        expect(view.queryByText('Checking messaging status...')).toBeNull();
        assertCapability(view, Screen, false);
        await fireEvent.press(view.getByText('Retry:undefined'));
        expect(view.queryByText(errorText)).toBeNull();
        assertCapability(view, Screen, true);
        expect(Alert.alert).not.toHaveBeenCalled();
      }
    );
  }
);

it('explains the disabled Inbox registration action', async () => {
  mockAccount.type = AccountType.WATCH;
  mockMessages.isKeyRegistered = false;
  const view = await render(<MessagesInboxScreen />);
  expect(view.getByText(explanation)).toBeTruthy();
  expect(view.queryByText('Enable Messaging:false')).toBeNull();
});

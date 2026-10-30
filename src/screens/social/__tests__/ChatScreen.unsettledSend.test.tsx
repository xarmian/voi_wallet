/**
 * A chat send that may have landed keeps its placeholder pending: no 'failed'
 * bubble, no retry, no alert (TASK-454). ChatScreen hands the placeholder to
 * the store's settle action, with the txid when the error carries one.
 */
import React from 'react';
import { Alert, Text as MockText } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import ChatScreen from '../ChatScreen';
import MessagingService from '@/services/messaging';
import {
  TransactionMaybeSubmittedError,
  TransactionPendingError,
} from '@/types/network';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

let mockThread: unknown;

const mockStore = {
  isInitialized: true,
  fetchThreadMessages: jest.fn(),
  fetchOlderMessages: jest.fn(),
  markThreadAsRead: jest.fn(),
  addPendingMessage: jest.fn(),
  updateMessageStatus: jest.fn(),
  removePendingMessage: jest.fn(),
  addMessage: jest.fn(),
  settlePendingMessage: jest.fn(),
  failPendingMessage: jest.fn(),
  threads: {} as Record<string, unknown>,
  expireUnsettledPlaceholders: jest.fn(),
  registerMessagingKey: jest.fn(),
  checkKeyRegistration: jest.fn(async () => true),
};

jest.mock('@/store/messagesStore', () => ({
  PENDING_PLACEHOLDER_PREFIX: 'pending-',
  useMessagesStore: Object.assign(() => mockStore, {
    getState: () => mockStore,
  }),
  useThread: () => mockThread,
}));
jest.mock('@/store/friendsStore', () => ({
  useFriendsStore: (select: (state: unknown) => unknown) =>
    select({ friends: [{ address: 'FRIEND', envoiName: 'Friend' }] }),
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => ({ id: 'me', address: 'ME' }),
}));
jest.mock('@/store/experimentalStore', () => ({
  useIsMessagingEnabled: () => true,
}));
jest.mock('../useMessagingSigner', () => ({
  useMessagingSigner: () => ({
    status: 'ready',
    ready: true,
    retry: jest.fn(),
    isLedgerBacked: false,
    canUseMessaging: true,
  }),
}));
jest.mock('../MessagingSignerNotice', () => ({
  MessagingSignerNotice: () => null,
}));
jest.mock('@/services/messaging', () => ({
  __esModule: true,
  default: { sendMessage: jest.fn() },
  isMessagingKeyRegistered: async () => true,
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useRoute: () => ({ params: { friendAddress: 'FRIEND' } }),
  useFocusEffect: (callback: () => void) => {
    const React = require('react');
    React.useEffect(() => callback(), [callback]);
  },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/utils/address', () => ({
  formatAddress: (address: string) => address,
}));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/social/MessagingInfoModal', () => () => null);
jest.mock('@/components/social/MessageInput', () => ({
  __esModule: true,
  default: ({ onSend }: { onSend: (content: string) => Promise<void> }) => (
    <MockText onPress={() => onSend('hello')}>send</MockText>
  ),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/social/MessageBubble', () => ({
  __esModule: true,
  default: ({
    message,
    onRetry,
  }: {
    message: { id: string };
    onRetry: (m: unknown) => void;
  }) => (
    <MockText onPress={() => onRetry(message)}>retry-{message.id}</MockText>
  ),
}));

const sendMessage = jest.mocked(MessagingService.sendMessage);

beforeEach(() => {
  jest.clearAllMocks();
  mockThread = undefined;
  mockStore.threads = {};
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function sendWith(error: unknown) {
  sendMessage.mockRejectedValue(error);
  const view = await render(<ChatScreen />);
  await act(async () => {
    await fireEvent.press(view.getByText('send'));
  });
  const tempId = mockStore.addPendingMessage.mock.calls[0][0].id as string;
  return { tempId };
}

it.each([
  ['pending, with its txid', () => new TransactionPendingError('TX1'), 'TX1'],
  [
    'maybe submitted, with no txid',
    () => new TransactionMaybeSubmittedError(),
    undefined,
  ],
])('keeps a %s send pending, with no failed state', async (_l, make, txId) => {
  const { tempId } = await sendWith(make());

  expect(tempId.startsWith('pending-')).toBe(true);
  expect(mockStore.settlePendingMessage).toHaveBeenCalledWith(
    tempId,
    txId,
    expect.any(Number)
  );
  expect(mockStore.updateMessageStatus).not.toHaveBeenCalledWith(
    tempId,
    'failed'
  );
  expect(mockStore.removePendingMessage).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('still marks a genuine failure failed, with a retry', async () => {
  const { tempId } = await sendWith(new Error('Recipient not registered'));

  expect(mockStore.failPendingMessage).toHaveBeenCalledWith(tempId);
  expect(mockStore.settlePendingMessage).not.toHaveBeenCalled();
});

// Codex pass A #1: nothing else polls an open chat, so the screen keeps
// resolving an unsettled placeholder while it is open, and stops when it isn't.
it('re-checks an unsettled placeholder while the chat is open', async () => {
  jest.useFakeTimers();
  try {
    mockThread = {
      messages: [
        {
          id: 'pending-1',
          threadId: 'FRIEND',
          direction: 'sent',
          content: 'hi',
          timestamp: 1,
          status: 'pending',
          fee: 1000,
          unsettled: true,
        },
      ],
    };
    const view = await render(<ChatScreen />);
    mockStore.fetchThreadMessages.mockClear();

    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    expect(mockStore.expireUnsettledPlaceholders).toHaveBeenCalledWith(
      'FRIEND'
    );
    // Local only: no network load on the timer (Codex pass B #1, #4).
    expect(mockStore.fetchThreadMessages).not.toHaveBeenCalled();

    await view.unmount();
    mockStore.expireUnsettledPlaceholders.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(60000);
    });
    expect(mockStore.expireUnsettledPlaceholders).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('does not poll when no placeholder is unsettled', async () => {
  jest.useFakeTimers();
  try {
    await render(<ChatScreen />);
    await act(async () => {
      jest.advanceTimersByTime(60000);
    });
    expect(mockStore.expireUnsettledPlaceholders).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

// Codex pass B #2: two taps on one failed row start one send, and a row that
// is no longer 'failed' can't be retried at all.
it('starts one send for two quick retries of the same failed row', async () => {
  const failed = {
    id: 'pending-9',
    threadId: 'FRIEND',
    direction: 'sent',
    content: 'again',
    timestamp: 1,
    status: 'failed',
    fee: 1000,
  };
  mockThread = { messages: [failed] };
  mockStore.threads = { FRIEND: { messages: [failed] } };
  let release!: (v: unknown) => void;
  sendMessage.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }) as never
  );
  const view = await render(<ChatScreen />);

  await act(async () => {
    fireEvent.press(view.getByText('retry-pending-9'));
    fireEvent.press(view.getByText('retry-pending-9'));
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);

  await act(async () => {
    release({ message: { ...failed, id: 'TXR', status: 'confirmed' } });
  });

  // Now pending (not failed): a further retry is refused.
  mockStore.threads = {
    FRIEND: { messages: [{ ...failed, status: 'pending', unsettled: true }] },
  };
  await act(async () => {
    fireEvent.press(view.getByText('retry-pending-9'));
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

// Codex pass D #2: ordinary success results still replace the optimistic row
// with the real one, confirmed or still pending by txid (confirmed:false).
it.each([
  ['confirmed', 'confirmed'],
  ['pending by txid', 'pending'],
] as const)('replaces the placeholder with a %s send', async (_l, status) => {
  const message = {
    id: 'REAL-TX',
    threadId: 'FRIEND',
    direction: 'sent',
    content: 'hello',
    timestamp: 2,
    status,
    fee: 1000,
  };
  sendMessage.mockResolvedValue({ txId: 'REAL-TX', message } as never);
  const view = await render(<ChatScreen />);
  await act(async () => {
    await fireEvent.press(view.getByText('send'));
  });

  const tempId = mockStore.addPendingMessage.mock.calls[0][0].id;
  expect(mockStore.removePendingMessage).toHaveBeenCalledWith(tempId);
  expect(mockStore.addMessage).toHaveBeenCalledWith(message);
  expect(mockStore.settlePendingMessage).not.toHaveBeenCalled();
  expect(mockStore.failPendingMessage).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});

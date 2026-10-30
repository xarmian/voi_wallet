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
  registerMessagingKey: jest.fn(),
  checkKeyRegistration: jest.fn(async () => true),
};

jest.mock('@/store/messagesStore', () => ({
  PENDING_PLACEHOLDER_PREFIX: 'pending-',
  useMessagesStore: Object.assign(() => mockStore, {
    getState: () => mockStore,
  }),
  useThread: () => undefined,
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

const sendMessage = jest.mocked(MessagingService.sendMessage);

beforeEach(() => {
  jest.clearAllMocks();
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
  expect(mockStore.settlePendingMessage).toHaveBeenCalledWith(tempId, txId);
  expect(mockStore.updateMessageStatus).not.toHaveBeenCalledWith(
    tempId,
    'failed'
  );
  expect(mockStore.removePendingMessage).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('still marks a genuine failure failed, with a retry', async () => {
  const { tempId } = await sendWith(new Error('Recipient not registered'));

  expect(mockStore.updateMessageStatus).toHaveBeenCalledWith(tempId, 'failed');
  expect(mockStore.settlePendingMessage).not.toHaveBeenCalled();
});

import React from 'react';
import { Text, Pressable, StyleSheet } from 'react-native';
import { act, render, fireEvent } from '@testing-library/react-native';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { RequestCoordinator } from '@/services/walletconnect/requestCoordinator';
import type { ReviewBinding } from '@/services/walletconnect/reviewBinding';
import type { SigningReviewParams } from '@/services/walletconnect/signRequestController';
import { getHeadSession } from '../headSession';
import WalletConnectHost from '../WalletConnectHost';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
let mockLocked = false;
let mockDraw = {
  authChecked: true,
  securityUnavailable: false,
  hasPin: true,
  pinSetupResume: false,
};
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      ...mockDraw,
      isLocked: mockLocked,
      isAuthenticated: !mockLocked,
    },
  }),
}));
const mockMount = jest.fn();
const mockUnmount = jest.fn();
const mockLeave = jest.fn();
const mockGrantLeave = jest.fn();
const mockCleanup = jest.fn();
const mockClearCallbacks = jest.fn();
function MockBody({ binding }: { binding: ReviewBinding }) {
  React.useEffect(() => {
    mockMount();
    const unsubscribe = binding.onLeave(mockLeave);
    return () => {
      mockUnmount();
      mockGrantLeave();
      mockCleanup();
      mockClearCallbacks();
      unsubscribe();
    };
  }, [binding]);
  return (
    <Pressable onPress={() => binding.nav.popOrReplace('Main')}>
      <Text>Approve fixture</Text>
    </Pressable>
  );
}
jest.mock('@/screens/walletconnect/SessionProposalScreen', () => ({
  ConnectReview: (props: { binding: ReviewBinding }) => <MockBody {...props} />,
}));
jest.mock('@/screens/wallet/UniversalTransactionSigningScreen', () => ({
  TransactionReview: (props: { binding: ReviewBinding }) => (
    <MockBody {...props} />
  ),
}));
const mockStart = jest.fn();
const mockDispose = jest.fn();
jest.mock('@/services/walletconnect/signRequestController', () => ({
  SignRequestController: jest.fn(() => ({
    start: mockStart,
    dispose: mockDispose,
  })),
}));
let queue: RequestQueue;
const coordinator = { isOpen: () => true, subscribe: () => () => {} };
beforeEach(() => {
  mockLocked = false;
  mockDraw = {
    authChecked: true,
    securityUnavailable: false,
    hasPin: true,
    pinSetupResume: false,
  };
  queue = new RequestQueue({
    coordinator,
    describeClose: () => ({
      title: 'fixture result',
      message: 'fixture message',
    }),
  });
  jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
  jest
    .spyOn(RequestCoordinator, 'getInstance')
    .mockReturnValue(coordinator as unknown as RequestCoordinator);
});
afterEach(() => {
  queue.__resetForTests();
  jest.restoreAllMocks();
});
function push(kind: 'request' | 'proposal', id = 1) {
  queue.push({
    ref: { version: 2, kind, topic: 'fixture', id },
    payload: { private: 'address amount note asset' },
    firstSeenMs: Date.now(),
    dapp: { name: 'fixture dapp', url: 'https://fixture.example' },
  });
  const session = getHeadSession(queue.getSnapshot().head!, {
    queue,
    coordinator,
  });
  if (kind === 'request') session.presentReview({} as SigningReviewParams);
  return session;
}
it.each(['proposal', 'request'] as const)(
  'DEFECT %s stays mounted with the same session and binding through active lock/unlock',
  async (kind) => {
    const session = push(kind);
    const view = await render(<WalletConnectHost />);
    const binding = session.binding;
    mockLocked = true;
    await view.rerender(<WalletConnectHost />);
    mockLocked = false;
    await view.rerender(<WalletConnectHost />);
    expect(getHeadSession(session.item, { queue, coordinator })).toBe(session);
    expect(session.binding).toBe(binding);
    expect(mockMount).toHaveBeenCalledTimes(1);
    expect(mockUnmount).not.toHaveBeenCalled();
    expect(mockLeave).not.toHaveBeenCalled();
    expect(mockGrantLeave).not.toHaveBeenCalled();
    expect(mockDispose).not.toHaveBeenCalled();
    expect(mockCleanup).not.toHaveBeenCalled();
    expect(mockClearCallbacks).not.toHaveBeenCalled();
    await fireEvent.press(view.getByText('Approve fixture'));
    expect(queue.getSnapshot().result?.title).toBe('fixture result');
    expect(mockLeave).toHaveBeenCalledTimes(1);
  }
);
it.each(['proposal', 'request'] as const)(
  'REGRESSION %s whole host unmount while locked does not end the session; remount reuses it',
  async (kind) => {
    const session = push(kind);
    const leave = jest.fn();
    session.binding.onLeave(leave);
    const view = await render(<WalletConnectHost />);
    mockLocked = true;
    await view.rerender(<WalletConnectHost />);
    await view.unmount();
    expect(leave).not.toHaveBeenCalled();
    const remount = await render(<WalletConnectHost />);
    expect(getHeadSession(session.item, { queue, coordinator })).toBe(session);
    expect(mockStart).toHaveBeenCalledTimes(kind === 'request' ? 1 : 0);
    expect(mockDispose).not.toHaveBeenCalled();
    await act(async () => {
      queue.closeHead(session.item.ref, 'expired');
    });
    expect(leave).toHaveBeenCalledTimes(1);
    await remount.unmount();
    expect(leave).toHaveBeenCalledTimes(1);
  }
);
it('DEFECT empty, head, result, dismiss, empty; result advances only with waiting', async () => {
  const view = await render(<WalletConnectHost />);
  expect(view.toJSON()).toBeNull();
  let session!: ReturnType<typeof push>;
  await act(async () => {
    session = push('proposal');
  });
  expect(view.getByText('Approve fixture')).toBeTruthy();
  await act(async () => {
    queue.closeHead(session.item.ref, 'declined');
  });
  expect(view.getByText('fixture message')).toBeTruthy();
  const dismiss = jest.spyOn(queue, 'dismissResult');
  const advance = jest.spyOn(queue, 'advance');
  await fireEvent.press(view.getByText('OK'));
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(view.toJSON()).toBeNull();
  await act(async () => {
    session = push('proposal');
    push('proposal', 2);
    queue.closeHead(session.item.ref, 'declined');
  });
  await fireEvent.press(view.getByText('OK'));
  expect(advance).toHaveBeenCalledTimes(1);
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(queue.getSnapshot().head?.ref.id).toBe(2);
});
it('DEFECT request starts once across rerender and lock/unlock before params exist', async () => {
  queue.push({
    ref: { version: 2, kind: 'request', topic: 'fixture', id: 1 },
    payload: {},
    firstSeenMs: Date.now(),
  });
  const session = getHeadSession(queue.getSnapshot().head!, {
    queue,
    coordinator,
  });
  const view = await render(<WalletConnectHost />);
  expect(session.getReviewParams()).toBeNull();
  expect(mockMount).not.toHaveBeenCalled();
  await view.rerender(<WalletConnectHost />);
  mockLocked = true;
  await view.rerender(<WalletConnectHost />);
  mockLocked = false;
  await view.rerender(<WalletConnectHost />);
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(session.controller).toBeDefined();
});

it.each([
  { authChecked: false },
  { securityUnavailable: true },
  { pinSetupResume: true, hasPin: false },
])(
  'DEFECT host refuses drawing %s and unmounts existing review without settling',
  async (state) => {
    push('proposal');
    const view = await render(<WalletConnectHost />);
    expect(mockMount).toHaveBeenCalledTimes(1);
    mockDraw = { ...mockDraw, ...state };
    await view.rerender(<WalletConnectHost />);
    expect(view.toJSON()).toBeNull();
    expect(mockUnmount).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().head).not.toBeNull();
    mockMount.mockClear();
    const fresh = await render(<WalletConnectHost />);
    expect(fresh.toJSON()).toBeNull();
    expect(mockMount).not.toHaveBeenCalled();
  }
);
it('DEFECT host root fills parent with opaque theme background; host never shows waiting summary', async () => {
  push('proposal');
  mockLocked = true;
  const view = await render(<WalletConnectHost />);
  const root = view.toJSON()!;
  expect(StyleSheet.flatten(root.props.style)).toMatchObject({
    ...StyleSheet.absoluteFill,
    backgroundColor: require('@/constants/themes').lightTheme.colors.background,
  });
  expect(view.queryByText('WalletConnect request waiting')).toBeNull();
});

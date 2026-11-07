import React from 'react';
import { Text, Pressable, StyleSheet, BackHandler } from 'react-native';
import { act, render, fireEvent, within } from '@testing-library/react-native';
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
    leave: jest.fn(),
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
    expect(queue.getSnapshot().result?.title).toBe(
      kind === 'request' ? 'Transaction Signed Successfully' : 'Success'
    );
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

it.each(
  [
    { authChecked: false },
    { securityUnavailable: true },
    { pinSetupResume: true, hasPin: false },
  ].flatMap((state) =>
    (['proposal', 'request'] as const).map((kind) => [state, kind] as const)
  )
)(
  'DEFECT host refuses drawing %j (%s): a review never drawn is not started, a drawn one leaves the queue and its review hears the end',
  async (state, kind) => {
    const drawable = { ...mockDraw };
    const session = push(kind);
    mockDraw = { ...mockDraw, ...state };
    const view = await render(<WalletConnectHost />);
    // Never drawn: nothing is rendered, started or ended.
    expect(view.toJSON()).toBeNull();
    expect(mockMount).not.toHaveBeenCalled();
    expect(session.drawn).toBe(false);
    expect(queue.getSnapshot().head).not.toBeNull();

    mockDraw = drawable;
    await view.rerender(<WalletConnectHost />);
    expect(mockMount).toHaveBeenCalledTimes(1);
    expect(session.drawn).toBe(true);

    // The app stack stops drawing: a live review nobody can see must not stay
    // open, and unmounting it alone would leave its buttons without callbacks.
    mockDraw = { ...drawable, ...state };
    await view.rerender(<WalletConnectHost />);
    expect(view.toJSON()).toBeNull();
    expect(mockUnmount).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().head).toBeNull();
    expect(queue.getSnapshot().result?.title).toBe('fixture result');

    // Drawing again shows the ended request's card, never a second review.
    mockDraw = drawable;
    await view.rerender(<WalletConnectHost />);
    expect(view.getByText('fixture result')).toBeTruthy();
    expect(mockMount).toHaveBeenCalledTimes(1);
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

describe('hardware back', () => {
  type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
  let handlers: BackListener[];
  let removed: jest.Mock;
  beforeEach(() => {
    handlers = [];
    removed = jest.fn();
    jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, handler) => {
        handlers.push(handler);
        return { remove: removed };
      });
  });
  const press = () =>
    handlers[handlers.length - 1]({} as Parameters<BackListener>[0]);

  it('DEFECT nothing shown registers no handler, so back keeps acting on the app stack', async () => {
    await render(<WalletConnectHost />);
    expect(handlers).toHaveLength(0);
  });
  it.each(['proposal', 'request'] as const)(
    "DEFECT back on a live %s review takes the review's own leave path and is consumed",
    async (kind) => {
      push(kind);
      const view = await render(<WalletConnectHost />);
      expect(handlers.length).toBeGreaterThan(0);
      let handled: boolean | undefined;
      await act(async () => {
        handled = press();
      });
      expect(handled).toBe(true);
      expect(mockLeave).toHaveBeenCalledTimes(1);
      expect(queue.getSnapshot().head).toBeNull();
      expect(queue.getSnapshot().result?.title).toBe('fixture result');
      expect(view.getByText('fixture result')).toBeTruthy();
    }
  );
  it('DEFECT back on a result card acts as OK: it advances when others wait, else dismisses', async () => {
    let session!: ReturnType<typeof push>;
    await act(async () => {
      session = push('proposal');
      push('proposal', 2);
      queue.closeHead(session.item.ref, 'declined');
    });
    const view = await render(<WalletConnectHost />);
    const advance = jest.spyOn(queue, 'advance');
    const dismiss = jest.spyOn(queue, 'dismissResult');
    await act(async () => {
      expect(press()).toBe(true);
    });
    expect(advance).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().head?.ref.id).toBe(2);
    await act(async () => {
      queue.closeHead(queue.getSnapshot().head!.ref, 'declined');
    });
    await act(async () => {
      expect(press()).toBe(true);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(view.toJSON()).toBeNull();
  });
  it('DEFECT back while locked is consumed and changes nothing', async () => {
    push('proposal');
    mockLocked = true;
    await render(<WalletConnectHost />);
    const snapshot = queue.getSnapshot();
    expect(press()).toBe(true);
    expect(queue.getSnapshot()).toBe(snapshot);
    expect(mockLeave).not.toHaveBeenCalled();
  });
  it('DEFECT back after the wallet locks later is consumed and changes nothing (no stale unlocked handler)', async () => {
    push('proposal');
    const view = await render(<WalletConnectHost />);
    mockLocked = true;
    await view.rerender(<WalletConnectHost />);
    const snapshot = queue.getSnapshot();
    expect(press()).toBe(true);
    expect(queue.getSnapshot()).toBe(snapshot);
    expect(mockLeave).not.toHaveBeenCalled();
  });
  it('DEFECT the handler is removed when the host has nothing to show', async () => {
    const session = push('proposal');
    await render(<WalletConnectHost />);
    await act(async () => {
      queue.closeHead(session.item.ref, 'declined');
      queue.dismissResult();
    });
    expect(removed).toHaveBeenCalled();
  });
});
it('DEFECT the result card keeps clear of the status bar and home indicator', async () => {
  const session = push('proposal');
  const view = await render(<WalletConnectHost />);
  await act(async () => {
    queue.closeHead(session.item.ref, 'declined');
  });
  type Node = ReturnType<typeof view.toJSON>;
  const find = (node: Node): Node | null => {
    if (!node || Array.isArray(node) || typeof node === 'string') return null;
    const edges = (node.props as { edges?: unknown }).edges;
    if (edges) return node;
    for (const child of node.children ?? []) {
      const found = find(child as Node);
      if (found) return found;
    }
    return null;
  };
  const safe = find(view.toJSON());
  expect(safe).not.toBeNull();
  expect((safe!.props as { edges: unknown }).edges).toMatchObject({
    top: 'additive',
    bottom: 'additive',
  });
  expect(within(view.root!).getByText('fixture result')).toBeTruthy();
});

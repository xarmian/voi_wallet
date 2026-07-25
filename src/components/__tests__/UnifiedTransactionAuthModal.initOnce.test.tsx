/**
 * TASK-241 — UnifiedTransactionAuthModal init/cancel latch (HT-254 Option A).
 *
 * The shared transaction-signing auth modal must call
 * `controller.initializeSigningFlow` EXACTLY ONCE per open (visible false→true)
 * and must NOT restart the flow after an explicit cancel while `visible` stays
 * true — even though `handleCancel` → `resetAfterDismiss()` drives the controller
 * back to `idle`.
 *
 * The pre-fix bug: `initialized`/`biometricAttempted`/`userCancelled` were
 * useState flags and a reset effect keyed on `authState.state === 'idle'` erased
 * all three on the very next commit after a cancel. So the moment the controller
 * bounced back to `idle` (which `resetAfterDismiss` does synchronously), the
 * cancel latch was wiped and the init effect re-fired — re-initializing the
 * signing flow while the modal was still visible. This test reproduces that
 * churn (a transient return to `idle`, and a cancel-with-visible-still-true) and
 * asserts init stays at a single invocation. It fails against the useState
 * implementation and passes once the flags are refs the reset can't erase.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

// Types-only at runtime; avoid loading the heavy controller / native ledger deps.
jest.mock('@/services/auth/transactionAuthController', () => ({}));
jest.mock('@/services/transactions/unifiedSigner', () => ({}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

jest.mock('@/components/remoteSigner', () => ({
  AnimatedQRCode: () => null,
  AnimatedQRScanner: () => null,
}));

jest.mock('@/services/remoteSigner', () => ({
  RemoteSignerService: {
    decodePayload: jest.fn(),
    encodePayload: jest.fn(() => ''),
  },
}));

jest.mock('@/types/remoteSigner', () => ({
  isRemoteSignerResponse: jest.fn(() => false),
}));

jest.mock('@/utils/haptics', () => ({ hapticNotify: jest.fn() }));

import UnifiedTransactionAuthModal from '../UnifiedTransactionAuthModal';

// Mirrors TransactionAuthController.getInitialState() — the shape the modal reads.
function idleState(overrides: Record<string, unknown> = {}) {
  return {
    state: 'idle',
    error: null,
    requiresPin: true,
    requiresBiometric: false,
    biometricAvailable: false,
    pinAttempts: 0,
    maxPinAttempts: 5,
    isLocked: false,
    isLedgerFlow: false,
    ledgerStatus: 'idle',
    ledgerDevice: null,
    ledgerError: null,
    isRemoteSignerFlow: false,
    remoteSignerStatus: 'idle',
    remoteSignerRequest: null,
    remoteSignerError: null,
    signingProgress: null,
    result: null,
    ...overrides,
  };
}

// Minimal stateful fake of TransactionAuthController: a subscribe/emit bus plus
// spies for the methods the modal drives. resetAfterDismiss() emits `idle` to
// subscribers, exactly like the real controller — that emission is what used to
// trigger the erase-the-latch bug.
function makeController(initial = idleState()) {
  let state: ReturnType<typeof idleState> = initial;
  const listeners = new Set<(s: unknown) => void>();
  const emit = (next: ReturnType<typeof idleState>) => {
    state = next;
    listeners.forEach((l) => l({ ...state }));
  };
  return {
    getState: jest.fn(() => ({ ...state })),
    subscribe: jest.fn((fn: (s: unknown) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    initializeSigningFlow: jest.fn(async () => {
      // Async determineAuthRequirements window: intentionally does NOT emit a
      // state change here, so the modal stays `idle` while init is "in flight".
    }),
    cancel: jest.fn(),
    resetAfterDismiss: jest.fn(() => emit(idleState())),
    authenticateWithPin: jest.fn(async () => false),
    authenticateWithBiometrics: jest.fn(async () => {}),
    retryLedgerConnection: jest.fn(),
    startRemoteSignerScan: jest.fn(),
    processRemoteSignerResponse: jest.fn(async () => {}),
    cancelRemoteSignerFlow: jest.fn(),
    _emit: emit,
  };
}

const asController = (c: ReturnType<typeof makeController>): any => c;

describe('UnifiedTransactionAuthModal init/cancel latch (TASK-241)', () => {
  const request = { kind: 'test-request' } as unknown as never;

  it('initializes exactly once per open across re-renders and a transient return to idle', async () => {
    const controller = makeController();
    const onComplete = jest.fn();
    const onCancel = jest.fn();

    const { rerender } = render(
      <UnifiedTransactionAuthModal
        visible
        controller={asController(controller)}
        request={request}
        onComplete={onComplete}
        onCancel={onCancel}
        message="msg-1"
      />
    );

    await waitFor(() =>
      expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1)
    );

    // Parent re-renders during the async init window (state still idle): a
    // benign prop change must not re-invoke init.
    rerender(
      <UnifiedTransactionAuthModal
        visible
        controller={asController(controller)}
        request={request}
        onComplete={onComplete}
        onCancel={onCancel}
        message="msg-2"
      />
    );
    expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1);

    // Controller progresses to authenticating, then bounces back to idle (what
    // resetAfterDismiss does mid-flow). The pre-fix reset effect cleared the
    // `initialized` flag on that idle emission and re-fired init. With refs it
    // must NOT.
    await act(async () => {
      controller._emit(idleState({ state: 'authenticating' }));
    });
    await act(async () => {
      controller._emit(idleState());
    });

    expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1);
  });

  it('does not re-initialize after handleCancel while visible stays true', async () => {
    const controller = makeController();
    const onComplete = jest.fn();
    // onCancel deliberately does NOT flip visible=false — models a consumer that
    // shows a confirm dialog / awaits a WalletConnect reject / animates dismiss.
    const onCancel = jest.fn();

    const { getByText, rerender } = render(
      <UnifiedTransactionAuthModal
        visible
        controller={asController(controller)}
        request={request}
        onComplete={onComplete}
        onCancel={onCancel}
        message="msg"
      />
    );

    await waitFor(() =>
      expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1)
    );

    // Explicit cancel. handleCancel calls resetAfterDismiss(), which emits idle.
    await act(async () => {
      fireEvent.press(getByText('Cancel'));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(controller.cancel).toHaveBeenCalledTimes(1);

    // visible stays true; force another parent re-render for good measure.
    rerender(
      <UnifiedTransactionAuthModal
        visible
        controller={asController(controller)}
        request={request}
        onComplete={onComplete}
        onCancel={onCancel}
        message="msg-after-cancel"
      />
    );

    // Simulate a later clean transition back to idle while visible stays true
    // (e.g. the confirm dialog / async reject settles and the controller
    // re-emits). The pre-fix reset effect erased the cancel latch on this idle
    // and re-fired init; the ref latch must keep it suppressed.
    await act(async () => {
      controller._emit(idleState({ state: 'authenticating' }));
    });
    await act(async () => {
      controller._emit(idleState());
    });

    // The cancel latch must survive the resetAfterDismiss-driven idle: init is
    // NOT called again while visible stays true.
    expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1);
  });

  it('re-initializes on a genuine reopen after cancel (close then open)', async () => {
    const controller = makeController();
    const onComplete = jest.fn();
    const onCancel = jest.fn();

    const props = (visible: boolean) => ({
      visible,
      controller: asController(controller),
      request,
      onComplete,
      onCancel,
      message: 'msg',
    });

    const { getByText, rerender } = render(
      <UnifiedTransactionAuthModal {...props(true)} />
    );

    await waitFor(() =>
      expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1)
    );

    await act(async () => {
      fireEvent.press(getByText('Cancel'));
    });

    // Genuine close (visible true→false): clears init/biometric latches.
    rerender(<UnifiedTransactionAuthModal {...props(false)} />);

    // Genuine reopen (visible false→true): clears the userCancelled latch first,
    // then the init effect re-initializes for the new open.
    await act(async () => {
      rerender(<UnifiedTransactionAuthModal {...props(true)} />);
    });

    await waitFor(() =>
      expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(2)
    );
  });
});

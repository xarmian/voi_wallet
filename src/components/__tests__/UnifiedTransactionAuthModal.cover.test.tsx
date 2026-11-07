import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

// Types-only at runtime; avoid loading the heavy controller / native ledger deps.
jest.mock('@/services/auth/transactionAuthController', () => ({}));
jest.mock('@/services/transactions/unifiedSigner', () => ({}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: ({ name }: { name: string }) =>
      require('react').createElement(require('react-native').Text, {
        testID: name,
      }),
  }),
  { virtual: true }
);

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
    resumeDeferredStart: jest.fn(async () => {}),
    setStartGate: jest.fn<void, [(() => boolean) | null]>(),
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
    authenticateWithReviewGrant: jest.fn(async () => false),
    authenticateWithPin: jest.fn(async () => false),
    authenticateWithBiometrics: jest.fn(async () => {}),
    retryLedgerConnection: jest.fn(),
    startRemoteSignerScan: jest.fn(),
    processRemoteSignerResponse: jest.fn(async () => {}),
    cancelRemoteSignerFlow: jest.fn(),
    _emit: emit,
  };
}

let mockCovered = false;
let mockBiometricDisabled: boolean | undefined;
let mockBiometricPress: (() => Promise<void>) | undefined;
let mockModalVisible: boolean | undefined;
jest.mock('@/hooks/useCoverPaused', () => ({
  useCoverPaused: () => mockCovered,
}));
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  const descriptors = Object.getOwnPropertyDescriptors(native);
  descriptors.TouchableOpacity = {
    configurable: true,
    enumerable: true,
    value: (props: React.ComponentProps<typeof native.TouchableOpacity>) => {
      if (
        require('react').isValidElement(props.children) &&
        props.children.props.name === 'finger-print'
      ) {
        mockBiometricDisabled = props.disabled;
        mockBiometricPress = props.onPress as () => Promise<void>;
      }
      return require('react').createElement(native.TouchableOpacity, props);
    },
  };
  descriptors.Modal = {
    configurable: true,
    enumerable: true,
    value: (props: React.ComponentProps<typeof native.Modal>) => {
      mockModalVisible = props.visible;
      return require('react').createElement(native.Modal, props);
    },
  };
  return Object.defineProperties({}, descriptors);
});

beforeEach(() => {
  mockCovered = false;
});
function setup(
  controller = makeController(),
  options: { biometricOnOpen?: boolean; reviewGrantKey?: string } = {}
) {
  const onComplete = jest.fn();
  const onCancel = jest.fn();
  const request = { reviewGrantKey: options.reviewGrantKey } as never;
  const element = (visible = true) => (
    <UnifiedTransactionAuthModal
      visible={visible}
      biometricOnOpen={options.biometricOnOpen}
      controller={controller as never}
      request={request}
      onComplete={onComplete}
      onCancel={onCancel}
    />
  );
  return { controller, onComplete, onCancel, element };
}
it('DEFECT 1: hides the Modal on cover and shows it on uncover', async () => {
  const { element } = setup();
  const view = await render(element());
  expect(mockModalVisible).toBe(true);
  mockCovered = true;
  await view.rerender(element());
  expect(mockModalVisible).toBe(false);
  mockCovered = false;
  await view.rerender(element());
  expect(mockModalVisible).toBe(true);
  await view.rerender(element(false));
  expect(mockModalVisible).toBe(false);
});
it('DEFECT 2: clears the typed digit across a cover', async () => {
  const { controller, element } = setup(
    makeController(idleState({ state: 'authenticating' }))
  );
  const view = await render(element());
  await fireEvent.press(view.getByText('1'));
  mockCovered = true;
  await view.rerender(element());
  mockCovered = false;
  await view.rerender(element());
  // Observe the entry via the next submission: five digits cannot submit an empty entry.
  for (const digit of ['2', '3', '4', '5', '6'])
    await fireEvent.press(view.getByText(digit));
  expect(controller.authenticateWithPin).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('7'));
  expect(controller.authenticateWithPin).toHaveBeenCalledWith('234567');
});
it('DEFECT 3: cover preserves init and close/reset call counts', async () => {
  const { controller, element, onCancel } = setup();
  const view = await render(element());
  expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1);
  mockCovered = true;
  await view.rerender(element());
  expect(controller.resetAfterDismiss).not.toHaveBeenCalled();
  expect(controller.cancel).not.toHaveBeenCalled();
  expect(mockModalVisible).toBe(false);
  mockCovered = false;
  await view.rerender(element());
  expect(controller.initializeSigningFlow).toHaveBeenCalledTimes(1);
  expect(controller.resetAfterDismiss).not.toHaveBeenCalled();
  expect(controller.cancel).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});
it('DEFECT 4: in-flight signing completes exactly once while covered without cleanup', async () => {
  const { controller, element, onComplete } = setup(
    makeController(idleState({ state: 'authenticating' }))
  );
  let resolve!: () => void;
  const signer = new Promise<void>((done) => {
    resolve = done;
  });
  controller.authenticateWithPin.mockImplementation(async () => {
    controller._emit(idleState({ state: 'signing' }));
    await signer;
    controller._emit(
      idleState({ state: 'completed', result: { success: true } })
    );
    return true;
  });
  const view = await render(element());
  for (const digit of ['1', '2', '3', '4', '5'])
    await fireEvent.press(view.getByText(digit));
  await Promise.all([
    fireEvent.press(view.getByText('6')),
    (async () => {
      await waitFor(() => expect(controller.getState().state).toBe('signing'));
      mockCovered = true;
      await view.rerender(element());
      expect(controller.resetAfterDismiss).not.toHaveBeenCalled();
      await act(async () => {
        resolve();
        await signer;
      });
    })(),
  ]);
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith(true, { success: true });
  expect(controller.resetAfterDismiss).not.toHaveBeenCalled();
  expect(controller.cancel).not.toHaveBeenCalled();
  expect(mockModalVisible).toBe(false);
  mockCovered = false;
  await view.rerender(element());
  expect(onComplete).toHaveBeenCalledTimes(1);
});
it('DEFECT 5: no PIN keypad is reachable while covered', async () => {
  const { element } = setup(
    makeController(idleState({ state: 'authenticating' }))
  );
  const view = await render(element());
  expect(view.getByText('1')).toBeTruthy();
  mockCovered = true;
  await view.rerender(element());
  expect(view.queryByText('1')).toBeNull();
});

import { isCovered, setCovered, resetCoverForTests } from '@/utils/lockCover';

describe('start policy (U3d-9)', () => {
  beforeEach(() => resetCoverForTests());
  afterEach(() => resetCoverForTests());
  it.each(['biometric', 'review'] as const)(
    'DEFECT: pending initialization %s checks synchronous cover and uncovered twin starts once',
    async (kind) => {
      for (const covered of [true, false]) {
        resetCoverForTests();
        const controller = makeController();
        const sign = jest.fn(() =>
          controller._emit(
            idleState({ state: 'completed', result: { success: true } })
          )
        );
        controller.authenticateWithBiometrics.mockImplementation(async () => {
          sign();
        });
        controller.authenticateWithReviewGrant.mockImplementation(async () => {
          sign();
          return true;
        });
        let finish!: () => void;
        controller.initializeSigningFlow.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = () => {
                controller._emit(
                  idleState({
                    state: 'authenticating',
                    biometricAvailable: true,
                  })
                );
                resolve();
              };
            })
        );
        const { element, onComplete } = setup(controller, {
          biometricOnOpen: true,
          reviewGrantKey: kind === 'review' ? 'grant' : undefined,
        });
        const view = await render(element());
        if (covered) setCovered(true);
        await act(async () => finish());
        const authenticate =
          kind === 'review'
            ? controller.authenticateWithReviewGrant
            : controller.authenticateWithBiometrics;
        expect(authenticate).toHaveBeenCalledTimes(covered ? 0 : 1);
        expect(sign).toHaveBeenCalledTimes(covered ? 0 : 1);
        expect(onComplete).toHaveBeenCalledTimes(covered ? 0 : 1);
        if (covered) {
          setCovered(false);
          await view.rerender(element());
          expect(authenticate).not.toHaveBeenCalled();
          expect(view.getByText('1')).toBeTruthy();
        }
        await view.unmount();
      }
    }
  );
  it.each([true, false])(
    'DEFECT: registered gate closure returns !isCovered() during pending PIN, cover=%s',
    async (covered) => {
      const controller = makeController(idleState({ state: 'authenticating' }));
      let finish!: () => void;
      const sign = jest.fn();
      controller.authenticateWithPin.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => {
              const gate = controller.setStartGate.mock.calls.at(-1)?.[0] as
                (() => boolean) | undefined;
              const allowed = gate ? gate() : true;
              if (allowed) sign();
              resolve(allowed);
            };
          })
      );
      const { element } = setup(controller);
      const view = await render(element());
      for (const digit of ['1', '2', '3', '4', '5', '6'])
        await fireEvent.press(view.getByText(digit));
      if (covered) setCovered(true);
      await act(async () => finish());
      expect(sign).toHaveBeenCalledTimes(covered ? 0 : 1);
      const gate = controller.setStartGate.mock.calls.at(-1)?.[0] as
        (() => boolean) | undefined;
      expect(gate?.()).toBe(!isCovered());
      await view.unmount();
      expect(controller.setStartGate).toHaveBeenLastCalledWith(null);
    }
  );
});

it.each([true, false])(
  'REGRESSION: manual biometric start observes synchronous cover=%s',
  async (cover) => {
    mockCovered = false;
    resetCoverForTests();
    const controller = makeController(
      idleState({ state: 'authenticating', biometricAvailable: true })
    );
    const { element } = setup(controller);
    const view = await render(element());
    if (cover) setCovered(true);
    await fireEvent.press(view.getByTestId('finger-print'));
    expect(controller.authenticateWithBiometrics).toHaveBeenCalledTimes(
      cover ? 0 : 1
    );
    await view.unmount();
    resetCoverForTests();
  }
);

it('DEFECT: Ledger deferred start resumes once on a covered-to-uncovered transition', async () => {
  const controller = makeController(
    idleState({
      state: 'authenticating',
      isLedgerFlow: true,
      ledgerStatus: 'ready',
    })
  );
  controller.resumeDeferredStart.mockImplementation(async () => {
    controller._emit(idleState({ state: 'signing', isLedgerFlow: true }));
  });
  const { element } = setup(controller);
  const view = await render(element());
  expect(controller.resumeDeferredStart).not.toHaveBeenCalled();
  mockCovered = true;
  await view.rerender(element());
  expect(controller.resumeDeferredStart).not.toHaveBeenCalled();
  mockCovered = false;
  await view.rerender(element());
  expect(controller.resumeDeferredStart).toHaveBeenCalledTimes(1);
  expect(controller.getState().state).toBe('signing');
  await view.rerender(element());
  expect(controller.resumeDeferredStart).toHaveBeenCalledTimes(1);
});

it('DEFECT: pending PIN disables biometric control and its queued handler; after verify it works', async () => {
  const controller = makeController(
    idleState({ state: 'authenticating', biometricAvailable: true })
  );
  let finish!: (valid: boolean) => void;
  controller.authenticateWithPin.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const { element } = setup(controller);
  const view = await render(element());
  for (const digit of ['1', '2', '3', '4', '5', '6'])
    await fireEvent.press(view.getByText(digit));
  const icon = view.getByTestId('finger-print');
  expect(mockBiometricDisabled).toBe(true);
  await fireEvent.press(icon);
  expect(controller.authenticateWithBiometrics).not.toHaveBeenCalled();
  await act(async () => {
    await mockBiometricPress?.();
  });
  expect(controller.authenticateWithBiometrics).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(mockBiometricDisabled).toBe(false);
  await fireEvent.press(view.getByTestId('finger-print'));
  expect(controller.authenticateWithBiometrics).toHaveBeenCalledTimes(1);
});

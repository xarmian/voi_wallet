import {
  TransactionAuthController,
  currentController,
  waitFor,
  setupOutcomeHarness,
  openOutcome,
  normalUnlock,
  lapse,
  texts as legacyTexts,
  key,
  result,
  inside,
  reviewGrant,
  SessionKeyVault,
  AccountSecureStorage,
  act,
  fireEvent,
} from './helpers/reviewOutcomeHarness';

setupOutcomeHarness();

// DEFECT harness: real coordinator and durable store; only the wire transport is fake.
import type React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
const callbackRegistry: typeof import('@/services/navigation/callbackRegistry') = require('@/services/navigation/callbackRegistry');
import {
  RequestCoordinator,
  EXIT_ANSWERS,
  type ExitReason,
  type RequestRef,
} from '@/services/walletconnect/requestCoordinator';
import { HandledStore } from '@/services/walletconnect/handledStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
const mockRequestRef: RequestRef = {
  version: 2,
  kind: 'request',
  topic: 'outcome-topic',
  id: 'fixture-request',
};
jest.mock('@/screens/wallet/UniversalTransactionSigningScreen', () => {
  const Actual = jest.requireActual(
    '@/screens/wallet/UniversalTransactionSigningScreen'
  ).default;
  return {
    __esModule: true,
    default: (
      props: React.ComponentProps<
        typeof import('../UniversalTransactionSigningScreen').default
      >
    ) => {
      const params = props.route.params;
      return require('react').createElement(Actual, {
        ...props,
        route: {
          ...props.route,
          params: {
            ...params,
            ...(params.walletConnect
              ? {
                  callbackId: 'coordinator-outcome',
                  walletConnect: {
                    ...params.walletConnect,
                    ref: mockRequestRef,
                  },
                }
              : {}),
          },
        },
      });
    },
  };
});
let coordinator: RequestCoordinator;
let onEnd: jest.Mock<Promise<void>, [ExitReason]>;
const wireAnswers: { recorded: boolean; code: number; message: string }[] = [];
beforeEach(async () => {
  await AsyncStorage.clear();
  wireAnswers.length = 0;
  coordinator = new RequestCoordinator({
    store: new HandledStore(),
    transport: {
      rejectRequestV2: async (_topic, _id, error) => {
        const persisted = new HandledStore();
        await persisted.load();
        wireAnswers.push({
          ...error,
          recorded: persisted.isHandled(mockRequestRef),
        });
      },
      rejectRequestV1: async () => {},
      rejectProposalV1: async () => {},
      rejectProposalV2: async () => {},
    },
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  await coordinator.admit(mockRequestRef);
  onEnd = jest.fn(async (reason: ExitReason) => {
    await coordinator.settle(mockRequestRef, reason);
  });
  jest
    .spyOn(callbackRegistry, 'getNavigationCallbacks')
    .mockReturnValue({ onEnd });
});
afterEach(() => coordinator.__resetForTests());
const expectEnd = (reason: Exclude<ExitReason, 'session-ended'>) => {
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onEnd).toHaveBeenCalledWith(
    reason,
    expect.objectContaining({ navigate: expect.any(Function) })
  );
  expect(wireAnswers).toEqual([{ ...EXIT_ANSWERS[reason], recorded: true }]);
};
const texts = {
  ...legacyTexts,
  lock: 'Your approval ended before signing finished. Try again in the dApp.',
  idle: 'Your approval timed out. Unlock to review this request again.',
  batch: legacyTexts.batch,
};

// DEFECT: a review outside the waiting queue receives no grant on normal unlock.
it.each(['lock'] as const)(
  'dangerAcknowledgedClearedByEveryLock:%s',
  async (reason) => {
    const h = await openOutcome({
      locked: false,
      danger: true,
      sign: false,
      waitingKeys: [],
    });
    await lapse('lock');
    // The queue snapshot is empty: this request has already been taken.
    await normalUnlock([]);
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(h.view.getByRole('checkbox')).not.toBeChecked();
    await fireEvent.press(h.view.getByRole('checkbox'));
    expect(h.view.getByRole('checkbox')).toBeChecked();
    await lapse(reason);
    await normalUnlock([]);
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(h.view.getByRole('checkbox')).not.toBeChecked();
    expect(h.signButton()).toBeDisabled();
    expect(h.modal().props.visible).toBe(false);
    expect(h.alert).not.toHaveBeenCalled();
  }
);

// DEFECT: a listener cancellation must not suppress cleanup in a later sitting.
it.each(['lapse', 'Cancel', 'failure', 'success'] as const)(
  'dangerAcknowledgedClearedAcrossSittings:%s',
  async (firstEnding) => {
    const h = await openOutcome({ danger: true, ledger: true });
    const controller = h.controller;
    if (firstEnding === 'lapse')
      await act(async () => jest.advanceTimersByTime(61_000));
    if (firstEnding === 'Cancel')
      await fireEvent.press(h.view.getByText('Cancel'));
    if (firstEnding === 'failure' || firstEnding === 'success') {
      await h.ready();
      if (firstEnding === 'success') await h.complete();
      else
        await act(async () => {
          h.callbacks().onError!(new Error('signing failed'));
          h.finishSigner();
        });
    }
    const firstAlerts =
      firstEnding === 'lapse' || firstEnding === 'failure' ? 1 : 0;
    if (firstEnding === 'failure') {
      expectEnd('sign-failed');
      await h.freshUnlock();
      await fireEvent.press(h.view.getByRole('checkbox'));
      const initialize = jest.spyOn(h.controller, 'initializeSigningFlow');
      await fireEvent.press(h.signButton());
      expect(initialize).not.toHaveBeenCalled();
      return;
    }
    expect(h.alert).toHaveBeenCalledTimes(firstAlerts);
    await h.freshUnlock();
    expect(currentController()).toBe(controller);
    expect(h.view.getByRole('checkbox').props.accessibilityState.checked).toBe(
      false
    );
    await fireEvent.press(h.view.getByRole('checkbox'));
    // Stay in review: opening a modal would initialize a new signing flow and
    // conceal a cancellation flag left over from the previous ending.
    await act(async () => jest.advanceTimersByTime(61_000));
    expect(h.view.queryByRole('checkbox')).toBeNull();
    await h.freshUnlock();
    expect(currentController()).toBe(controller);
    expect(h.view.getByRole('checkbox').props.accessibilityState.checked).toBe(
      false
    );
    expect(h.signButton()).toBeDisabled();
    // The review-only lapse is quiet; lapses while the modal is open alert.
    await fireEvent.press(h.view.getByRole('checkbox'));
    await fireEvent.press(h.signButton());
    await act(async () => jest.advanceTimersByTime(61_000));
    expect(h.alert).toHaveBeenCalledTimes(firstAlerts + 1);
    expect(h.alert).toHaveBeenLastCalledWith('Approval ended', texts.idle);
  }
);

// REGRESSION: the user's own Cancel is quiet even after a listener cancellation.
it('userCancelStillQuietAcrossSittings', async () => {
  const h = await openOutcome({ ledger: true });
  await act(async () => jest.advanceTimersByTime(61_000));
  expect(h.alert).toHaveBeenCalledTimes(1);
  await h.freshUnlock();
  await fireEvent.press(h.signButton());
  await fireEvent.press(h.view.getByText('Cancel'));
  expect(h.alert).toHaveBeenCalledTimes(1);
  expect(h.modal().props.visible).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});

// DEFECT
it('lockedSigningSuccessReachesDappOnce', async () => {
  const h = await openOutcome();
  await h.complete();
  expect(h.onSuccess).toHaveBeenCalledTimes(1);
  expect(h.onSuccess).toHaveBeenCalledWith(
    result,
    expect.objectContaining({ navigate: expect.any(Function) })
  );
  expect(h.alert).not.toHaveBeenCalled();
  expect(SessionKeyVault.isUnlocked()).toBe(false);
  expect(
    h.view.getByText(
      'Unlock to review this request. Your wallet will stay locked.'
    )
  ).toBeTruthy();
  expect(h.controller.getState().state).toBe('idle');
  expect(reviewGrant.isValid(key)).toBe(false);
});
// DEFECT
it('lockedSigningFailureShowsAlert', async () => {
  const h = await openOutcome();
  const beforeAlert: boolean[] = [];
  h.alert.mockImplementation(() => {
    beforeAlert.push(SessionKeyVault.isUnlocked());
  });
  await act(async () => {
    h.callbacks().onError!(new Error('TransactionPool.Remember: overspend'));
  });
  expect(h.alert).toHaveBeenCalledWith(
    'Not Enough Balance',
    expect.stringContaining("doesn't have enough balance")
  );
  expect(beforeAlert).toEqual([true]);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
  expect(h.onSuccess).not.toHaveBeenCalled();
  expect(
    h.view.getByText(
      'Unlock to review this request. Your wallet will stay locked.'
    )
  ).toBeTruthy();
});
// DEFECT
it.each(['lock', 'background', 'rotation'] as const)(
  'lockedLapseShowsExactText:%s',
  async (reason) => {
    const h = await openOutcome();
    await lapse(reason);
    expect(h.modal().props.visible).toBe(reason !== 'background');
    expect(h.modal().props.message).toBe('');
    await h.complete();
    expect(h.onSuccess).not.toHaveBeenCalled();
    if (reason === 'background') {
      expect(h.alert).not.toHaveBeenCalled();
      expectEnd('lapsed');
    } else {
      expect(h.alert).toHaveBeenCalledTimes(1);
      expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
    }
    // A rotation replaced the vault: the replacement belongs to whoever set it
    // (a normal unlock or the restore flow), so the sitting leaves it alone.
    expect(SessionKeyVault.isUnlocked()).toBe(reason === 'rotation');
    expect(h.modal().props.visible).toBe(false);
  }
);
// DEFECT: the non-batch row is defensive; attach its type on the real controller's request.
it.each(['batch_transaction', 'keyreg'] as const)(
  'lockedSignedThenLapsedBatchAndNonBatchExactText:%s',
  async (type) => {
    const h = await openOutcome();
    inside(h.controller).currentRequest!.type = type;
    await act(async () => {
      h.callbacks().onNetworkSubmit!();
    });
    await lapse('lock');
    await h.complete();
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(
      'Request ended',
      type === 'batch_transaction' ? texts.batch : texts.other
    );
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  }
);
// DEFECT
it('lockedRemoteSignerShowsUnlockMessage', async () => {
  const qr = jest.spyOn(insidePrototype(), 'initializeRemoteSignerFlow');
  const h = await openOutcome({ remote: true });
  expect(h.alert).toHaveBeenCalledWith('Approval ended', texts.remote);
  expect(qr).not.toHaveBeenCalled();
  expect(SessionKeyVault.isUnlocked()).toBe(false);
  expect(h.onSuccess).not.toHaveBeenCalled();
});
const insidePrototype = () => inside(TransactionAuthController.prototype);
// DEFECT
it.each([true, false])(
  'ledgerIdleBeforeSignerShowsTimedOutText:locked=%s',
  async (locked) => {
    const h = await openOutcome({ locked, ledger: true });
    expect(h.signer).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(61_000);
    });
    expect(h.alert).toHaveBeenCalledWith('Approval ended', texts.idle);
    expect(h.modal().props.visible).toBe(false);
    expect(SessionKeyVault.isUnlocked()).toBe(!locked);
    expect(h.onSuccess).not.toHaveBeenCalled();
  }
);
// REGRESSION: each message comes from a real controller decision.
it.each([
  'lock',
  'background',
  'rotation',
  'batch',
  'other',
  'idle',
  'unlock',
  'noPin',
  'unreadable',
] as const)('unlockedOutcomeTextsAtTheAlert:%s', async (name) => {
  if (name === 'noPin')
    (AccountSecureStorage.hasPin as jest.Mock).mockResolvedValueOnce(false);
  if (name === 'unreadable')
    (AccountSecureStorage.hasPin as jest.Mock).mockRejectedValueOnce(
      new Error('unavailable')
    );
  if (name === 'unlock')
    (AccountSecureStorage.hasPin as jest.Mock).mockImplementationOnce(
      async () => {
        expect(
          reviewGrant.consume(
            key,
            inside(currentController()).getReviewDigest()!
          )
        ).toBe(true);
        return true;
      }
    );
  const h = await openOutcome({ locked: false, ledger: name === 'idle' });
  if (name === 'idle')
    await act(async () => {
      jest.advanceTimersByTime(61_000);
    });
  if (['lock', 'background', 'rotation'].includes(name)) {
    await lapse(name as 'lock' | 'background' | 'rotation');
    await h.complete();
  }
  if (name === 'batch' || name === 'other') {
    inside(h.controller).currentRequest!.type =
      name === 'batch' ? 'batch_transaction' : 'keyreg';
    await act(async () => {
      h.callbacks().onNetworkSubmit!();
    });
    await lapse('lock');
    await h.complete();
  }
  const message = ['background', 'rotation'].includes(name)
    ? texts.lock
    : texts[name as keyof typeof texts];
  if (name === 'background') {
    expect(h.alert).not.toHaveBeenCalled();
    expectEnd('lapsed');
  } else {
    expect(h.alert).toHaveBeenCalledWith(
      ['idle', 'unlock'].includes(name) ? 'Approval ended' : 'Request ended',
      message
    );
  }
  expect(h.onSuccess).not.toHaveBeenCalled();
});
// DEFECT
it.each(['PIN', 'biometric'] as const)(
  'spentLedgerFlowDoesNotRestartOnReady:%s',
  async (method) => {
    const h = await openOutcome({ locked: false, ledger: true });
    await h.ready();
    expect(h.signer).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.callbacks().onError!(new Error('device locked'));
      h.finishSigner();
      await Promise.resolve();
      inside(h.controller).updateState({ ledgerStatus: 'ready' });
      void inside(h.controller).maybeStartSigningIfReady();
      expect(h.signer).toHaveBeenCalledTimes(1);
      if (method === 'PIN') void h.controller.authenticateWithPin('123456');
      else {
        const local = require('expo-local-authentication');
        local.authenticateAsync.mockResolvedValueOnce({ success: true });
        inside(h.controller).updateState({ biometricAvailable: true });
        void h.controller.authenticateWithBiometrics();
      }
    });
    expect(h.signer).toHaveBeenCalledTimes(2);
  }
);
// DEFECT for non-batch, REGRESSION for batch.
it.each([
  'voi_transfer',
  'rekey',
  'keyreg',
  'appl',
  'batch_transaction',
] as const)('cancelScopeBatchOnly:%s', async (type) => {
  const h = await openOutcome({ ledger: true });
  inside(h.controller).currentRequest!.type = type;
  await h.ready();
  await act(async () => {
    inside(h.controller).updateState({
      state: 'signing',
      ledgerStatus: 'waiting_confirmation',
    });
  });
  const cancel = jest.spyOn(h.controller, 'cancel');
  expect(h.view.queryByText('Cancel') !== null).toBe(
    type === 'batch_transaction'
  );
  await act(async () => {
    const visit = (node: any): any => {
      if (node.props?.onRequestClose) return node;
      for (const child of node.children ?? []) {
        if (typeof child === 'object') {
          const found = visit(child);
          if (found) return found;
        }
      }
    };
    visit(h.view.container).props.onRequestClose();
  });
  expect(cancel.mock.calls.length > 0).toBe(type === 'batch_transaction');
});
// REGRESSION: Cancel suppresses delivery of late signer callbacks.
it('cancelThenDeviceApprovesDeliversNothing', async () => {
  const h = await openOutcome({ ledger: true });
  await h.ready();
  await fireEvent.press(h.view.getByText('Cancel'));
  await act(async () => {
    h.callbacks().onNetworkSubmit!();
    h.callbacks().onNetworkConfirmed!('late', true);
  });
  await h.complete();
  expect(h.onSuccess).not.toHaveBeenCalled();
  expect(SessionKeyVault.isUnlocked()).toBe(false);
  expect(reviewGrant.isValid(key)).toBe(false);
});
// DEFECT: initial PIN refusal is an outcome and must be published before teardown.
it.each([false, 'unreadable'] as const)(
  'lockedPinRefusalAtAlert:%s',
  async (refusal) => {
    if (refusal === false)
      (AccountSecureStorage.hasPin as jest.Mock).mockResolvedValueOnce(false);
    else
      (AccountSecureStorage.hasPin as jest.Mock).mockRejectedValueOnce(
        new Error('unavailable')
      );
    const h = await openOutcome();
    expect(h.alert).toHaveBeenCalledWith(
      'Request ended',
      refusal === false ? texts.noPin : texts.unreadable
    );
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  }
);

// REGRESSION: a throwing callback must preserve the lapse ending too.
it.each(['lock', 'background', 'rotation'] as const)(
  'lockedSignerThrowAfterLapseShowsExactText:%s',
  async (reason) => {
    const h = await openOutcome();
    await lapse(reason);
    await h.rejectSigner();
    expect(h.onSuccess).not.toHaveBeenCalled();
    if (reason === 'background') {
      expect(h.alert).not.toHaveBeenCalled();
      expectEnd('lapsed');
    } else expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
    expect(SessionKeyVault.isUnlocked()).toBe(reason === 'rotation');
  }
);

// DEFECT
it.each([false, true])(
  'inAppModalClosesBeforeOnSuccessResolves:reject=%s',
  async (reject) => {
    const h = await openOutcome({ locked: false, inApp: true });
    let finish!: () => void;
    h.onSuccess.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await h.complete();
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
    expect(h.modal().props.visible).toBe(false);
    await act(async () => {
      finish();
    });
    expect(h.controller.getState().state).toBe('idle');
    if (reject) {
      await fireEvent.press(h.signButton());
      h.onSuccess.mockRejectedValueOnce(new Error('submit failed'));
      // Modal completion consumes the returned promise; exercise the screen callback directly to observe rejection.
      await act(async () => {
        await expect(h.modal().props.onComplete(true, result)).rejects.toThrow(
          'submit failed'
        );
      });
      expect(h.modal().props.visible).toBe(false);
      expect(h.controller.getState().state).toBe('idle');
    }
  }
);
// REGRESSION
it('walletConnectModalStaysUntilDelivery', async () => {
  const h = await openOutcome();
  let finish!: () => void;
  h.onSuccess.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await h.complete();
  expect(h.modal().props.visible).toBe(true);
  expect(SessionKeyVault.isUnlocked()).toBe(true);
  await act(async () => {
    finish();
  });
  expect(h.modal().props.visible).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});
// DEFECT for locked; REGRESSION for unlocked.
it.each(
  [true, false].flatMap((locked) =>
    ['Cancel', 'back'].map((exit) => ({ locked, exit }))
  )
)(
  'userCancelInAuthenticatingShowsNoAlert:locked=$locked:$exit',
  async ({ locked, exit }) => {
    const h = await openOutcome({ locked, ledger: true });
    expect(h.controller.getState().state).toBe('authenticating');
    const cancel = jest.spyOn(h.controller, 'cancel');
    if (exit === 'Cancel') await fireEvent.press(h.view.getByText('Cancel'));
    else await h.systemBack();
    expect(h.alert).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.modal().props.visible).toBe(false);
    expect(SessionKeyVault.isUnlocked()).toBe(!locked);
  }
);
// REGRESSION: fresh gate authentication also clears the acknowledgement.
it.each(['success', 'failure', 'Cancel', 'lapse'] as const)(
  'dangerAcknowledgedClearedOnEveryEnding:locked:%s',
  async (exit) => {
    const h = await openOutcome({
      danger: true,
      ledger: exit === 'Cancel' || exit === 'lapse',
    });
    expect(h.view.getByRole('checkbox').props.accessibilityState.checked).toBe(
      true
    );
    if (exit === 'success') await h.complete();
    if (exit === 'failure')
      await act(async () => {
        h.callbacks().onError!(new Error('signing failed'));
      });
    if (exit === 'Cancel') await fireEvent.press(h.view.getByText('Cancel'));
    if (exit === 'lapse')
      await act(async () => {
        jest.advanceTimersByTime(61_000);
      });
    await h.freshUnlock();
    expect(h.view.getByRole('checkbox').props.accessibilityState.checked).toBe(
      false
    );
    expect(h.signButton()).toBeDisabled();
  }
);
// DEFECT for success, failure and Cancel; REGRESSION for lapse, cleared by the listener.
// The unlocked review stays mounted across attempts on the same bytes.
it.each(['success', 'failure', 'Cancel', 'lapse'] as const)(
  'dangerAcknowledgedClearedOnEveryEnding:unlocked:%s',
  async (exit) => {
    const h = await openOutcome({
      locked: false,
      danger: true,
      ledger: exit === 'Cancel' || exit === 'lapse',
    });
    expect(h.view.getByRole('checkbox').props.accessibilityState.checked).toBe(
      true
    );
    if (exit === 'success') await h.complete();
    if (exit === 'failure')
      await act(async () => {
        h.callbacks().onError!(new Error('signing failed'));
      });
    if (exit === 'Cancel') await fireEvent.press(h.view.getByText('Cancel'));
    if (exit === 'lapse')
      await act(async () => {
        jest.advanceTimersByTime(61_000);
      });
    expect(h.view.getByRole('checkbox').props.accessibilityState.checked).toBe(
      false
    );
    expect(h.signButton()).toBeDisabled();
  }
);
// DEFECT: completion can precede the modal effect that resets the controller.
it('lateCallbackAfterCompleteIsIgnored', async () => {
  const h = await openOutcome();
  await act(async () => {
    h.callbacks().onComplete!(result);
    const state = h.controller.getState();
    h.callbacks().onLedgerRejected!({
      index: 2,
      total: 2,
      error: new Error('device locked'),
    });
    h.callbacks().onLedgerSigned!({ index: 2, total: 2 });
    h.callbacks().onLedgerPrompt!({ index: 2, total: 2 });
    h.callbacks().onError!(new Error('late failure'));
    h.callbacks().onNetworkSubmit!();
    h.callbacks().onNetworkConfirmed!('late', true);
    expect(h.controller.getState()).toEqual(state);
  });
  expect(h.onSuccess).toHaveBeenCalledTimes(1);
});

// DEFECT: exercise the real sequential batch loop; only the device entry call is stubbed.
it.each([true, false])(
  'ledgerCancelStartsNoEntryAfterTheEnteredOne:locked=%s',
  async (locked) => {
    const h = await openOutcome({
      locked,
      ledger: true,
      realSigner: true,
      entries: 3,
    });
    let finish!: (bytes: Uint8Array) => void;
    h.deviceSign.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        })
    );
    h.deviceSign.mockResolvedValue(new Uint8Array([1]));
    await h.ready();
    await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
    await fireEvent.press(h.view.getByText('Cancel'));
    await act(async () => {
      finish(new Uint8Array([1]));
      await h.signerRuns[0];
    });
    expect(h.deviceSign).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).not.toHaveBeenCalled();
  }
);
// REGRESSION: terminal Cancel never retries the old dApp request, even after the device stops.
it.each([true, false])(
  'terminalCancelDoesNotRestartOldLedgerRequest:locked=%s',
  async (locked) => {
    const h = await openOutcome({
      locked,
      ledger: true,
      realSigner: true,
      entries: 3,
    });
    let finish!: (bytes: Uint8Array) => void;
    h.deviceSign.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        })
    );
    h.deviceSign.mockResolvedValue(new Uint8Array([1]));
    await h.ready();
    await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
    await fireEvent.press(h.view.getByText('Cancel'));
    expectEnd('declined');
    await h.freshUnlock();
    const initialize = jest.spyOn(h.controller, 'initializeSigningFlow');
    await fireEvent.press(h.signButton());
    expect(initialize).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.deviceSign).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).not.toHaveBeenCalled();
    await act(async () => {
      finish(new Uint8Array([1]));
      await h.signerRuns[0];
    });
    await h.freshUnlock();
    await fireEvent.press(h.signButton());
    expect(initialize).not.toHaveBeenCalled();
    expect(h.deviceSign).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).not.toHaveBeenCalled();
    expectEnd('declined');
  }
);

// DEFECT: signer entry stays sticky after capability cleanup, Cancel and modal reset.
it('DEFECT hasEnteredSigner is sticky until initializeSigningFlow', async () => {
  const h = await openOutcome({ ledger: true });
  expect(h.controller.hasEnteredSigner()).toBe(false);
  const request = { ...inside(h.controller).currentRequest! };
  const atError: boolean[] = [];
  const stop = h.controller.subscribe((state) => {
    if (state.state === 'error') atError.push(h.controller.hasEnteredSigner());
  });
  await h.ready();
  expect(h.controller.hasEnteredSigner()).toBe(true);
  await lapse('lock');
  await h.complete();
  stop();
  expect(atError).toContain(true);
  expect(h.controller.hasEnteredSigner()).toBe(true);
  h.controller.cancel();
  h.controller.resetAfterDismiss();
  expect(h.controller.hasEnteredSigner()).toBe(true);
  await act(async () =>
    h.controller.initializeSigningFlow({
      ...request,
      reviewGrantKey: undefined,
    })
  );
  expect(h.controller.hasEnteredSigner()).toBe(false);
});

it('DEFECT signer entered failure answers sign-failed once with failure copy', async () => {
  const h = await openOutcome();
  await act(async () => h.callbacks().onError!(new Error('signing failed')));
  expect(h.alert).toHaveBeenCalledWith(
    'Signing failed',
    "Couldn't sign. Try again in the dApp."
  );
  expectEnd('sign-failed');
  await act(async () => h.modal().props.onCancel());
  expectEnd('sign-failed');
});

it('DEFECT signer entered Cancel answers declined after modal cleanup', async () => {
  const h = await openOutcome({ ledger: true });
  await h.ready();
  await fireEvent.press(h.view.getByText('Cancel'));
  expectEnd('declined');
  await act(async () => h.modal().props.onCancel());
  expectEnd('declined');
});

it.each(['lock', 'rotation'] as const)(
  'DEFECT pre-signer %s is nonterminal and permits fresh review',
  async (reason) => {
    const h = await openOutcome({ ledger: true });
    await lapse(reason);
    expect(h.alert).toHaveBeenCalledWith(
      'Approval ended',
      'Unlock to review this request again.'
    );
    expect(onEnd).not.toHaveBeenCalled();
    expect(coordinator.isOpen(mockRequestRef)).toBe(true);
    const deadline = coordinator.describe(mockRequestRef)?.deadlineMs;
    await h.freshUnlock();
    await fireEvent.press(h.signButton());
    expect(h.modal().props.visible).toBe(true);
    expect(coordinator.describe(mockRequestRef)?.deadlineMs).toBe(deadline);
  }
);

it('DEFECT pre-signer timeout is nonterminal with approval copy', async () => {
  const h = await openOutcome({ ledger: true });
  await act(async () => jest.advanceTimersByTime(61_000));
  expect(h.alert).toHaveBeenCalledWith('Approval ended', texts.idle);
  expect(onEnd).not.toHaveBeenCalled();
  expect(wireAnswers).toEqual([]);
});

it('DEFECT signer entered ReviewEndedError answers lapsed with post-signer copy', async () => {
  const h = await openOutcome();
  await lapse('lock');
  await h.complete();
  expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
  expectEnd('lapsed');
  await act(async () => h.modal().props.onCancel());
  expectEnd('lapsed');
});

it.each([false, true])(
  'DEFECT background ends request: entered=%s',
  async (entered) => {
    const h = await openOutcome({ ledger: true });
    if (entered) await h.ready();
    await lapse('background');
    expectEnd(entered ? 'lapsed' : 'background');
    await lapse('background');
    expectEnd(entered ? 'lapsed' : 'background');
    expect(h.alert).not.toHaveBeenCalled();
  }
);

it('REGRESSION background during outcome delivery sends nothing', async () => {
  const h = await openOutcome();
  let finish!: () => void;
  h.onSuccess.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await h.complete();
  await lapse('background');
  expect(onEnd).not.toHaveBeenCalled();
  expect(wireAnswers).toEqual([]);
  await act(async () => finish());
});

it.each(['expired', 'session-ended'] as const)(
  'DEFECT external %s closes shown request once',
  async (reason) => {
    const h = await openOutcome({ ledger: true });
    await act(async () => coordinator.settle(mockRequestRef, reason));
    expect(h.alert).toHaveBeenCalledWith(
      'Request ended',
      reason === 'expired'
        ? 'Request expired. Try again in the dApp.'
        : 'Connection ended. Reconnect in the dApp.'
    );
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(
      reason,
      expect.objectContaining({ navigate: expect.any(Function) })
    );
    await act(async () => coordinator.settle(mockRequestRef, reason));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(wireAnswers).toEqual(
      reason === 'expired' ? [{ ...EXIT_ANSWERS.expired, recorded: true }] : []
    );
  }
);

// DEFECT: all three pre-signer refusals must carry the nonterminal approval title.
it.each(['consume', 'authorization', 'pauseIdle'] as const)(
  'DEFECT pre-signer controller title: %s',
  async (site) => {
    const h = await openOutcome({ ledger: true });
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow({
      ...inside(h.controller).currentRequest!,
    });
    const state = inside(controller);
    state.updateState({
      state: 'authenticating',
      isLedgerFlow: true,
      ledgerStatus: 'ready',
    });
    state.reviewAuthorized = false;
    if (site === 'consume') {
      jest.spyOn(reviewGrant, 'consume').mockReturnValueOnce(false);
      await act(async () => controller.authenticateWithReviewGrant(key));
    } else if (site === 'authorization') {
      await act(async () => state.startSigning());
    } else {
      state.reviewAuthorized = true;
      jest.spyOn(reviewGrant, 'isConsumedFor').mockReturnValueOnce(true);
      jest.spyOn(reviewGrant, 'pauseIdle').mockReturnValueOnce(false);
      await act(async () => state.startSigning());
    }
    expect(controller.hasEnteredSigner()).toBe(false);
    expect(controller.getState().error).toMatchObject({
      title: 'Approval ended',
      message: texts.unlock,
    });
    expect(onEnd).not.toHaveBeenCalled();
  }
);

// DEFECT: the lapse subscriber also terminates an entered signer between device phases.
it('DEFECT signer entered timed out lapse is terminal with post-signer timeout copy', async () => {
  const h = await openOutcome({ ledger: true });
  await h.ready();
  await act(async () => {
    inside(h.controller).updateState({ state: 'authenticating' });
    jest.spyOn(reviewGrant, 'endReason').mockReturnValue('idle');
    reviewGrant.revoke(false, 'idle');
  });
  expect(h.alert).toHaveBeenCalledWith(
    'Request ended',
    'Your approval timed out before signing finished. Try again in the dApp.'
  );
  expectEnd('lapsed');
});

it.each(['background', 'failure'] as const)(
  'DEFECT WalletConnect signer without review grant ends as %s',
  async (ending) => {
    const h = await openOutcome({ locked: false, waitingKeys: [] });
    expect(inside(h.controller).currentRequest?.reviewGrantKey).toBeUndefined();
    await act(async () => {
      void h.controller.authenticateWithPin('123456');
    });
    await waitFor(() => expect(h.signer).toHaveBeenCalledTimes(1));
    expect(h.signer).toHaveBeenCalledTimes(1);
    if (ending === 'background') await lapse('background');
    else
      await act(async () =>
        h.callbacks().onError!(new Error('signing failed'))
      );
    expectEnd(ending === 'background' ? 'lapsed' : 'sign-failed');
  }
);
it('DEFECT Android back during grant response publish cannot decline or advance', async () => {
  const h = await openOutcome();
  let finish!: () => void;
  h.onSuccess.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await h.complete();
  await act(async () => h.modal().props.onCancel());
  expect(onEnd).not.toHaveBeenCalled();
  expect(wireAnswers).toEqual([]);
  expect(h.modal().props.visible).toBe(true);
  await act(async () => finish());
});

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));
import Toast from 'react-native-toast-message';

it('DEFECT late Sign refuses before auth initialization or signer with nothing-signed toast', async () => {
  const h = await openOutcome({ sign: false });
  const initialize = jest.spyOn(h.controller, 'initializeSigningFlow');
  // Move wall time alone: the expiry timer has not fired yet.
  jest.setSystemTime(Date.now() + 300_000);
  await fireEvent.press(h.signButton());
  expect(h.modal().props.visible).toBe(false);
  expect(initialize).not.toHaveBeenCalled();
  expect(h.signer).not.toHaveBeenCalled();
  expect(Toast.show).toHaveBeenCalledWith({
    type: 'info',
    text1: 'Request expired',
    text2: 'Nothing was signed. Try again in the dApp.',
  });
  expectEnd('expired');
});

it.each(['success', 'reject', 'end'] as const)(
  'DEFECT UTS %s callback receives targeted scoped navigation',
  async (ending) => {
    const callback = jest.fn(async (_result?: unknown, _nav?: unknown) => {});
    jest.mocked(callbackRegistry.getNavigationCallbacks).mockReturnValue({
      onSuccess: callback,
      onReject: callback,
      onEnd: callback,
    });
    const h = await openOutcome({ sign: ending === 'success' });
    if (ending === 'success') await h.complete();
    else if (ending === 'reject')
      await fireEvent.press(h.view.getByText('Reject'));
    else await act(async () => coordinator.settle(mockRequestRef, 'expired'));
    expect(callback).toHaveBeenCalledTimes(1);
    const args = callback.mock.calls[0];
    const nav = args[ending === 'reject' ? 0 : 1] as { goBack(): void };
    nav.goBack();
    expect(h.dispatch).toHaveBeenCalledWith(expect.any(Function));
    expect(h.goBack).not.toHaveBeenCalled();
  }
);

it('U6 retained route after signer entry and failed publish never claims nothing was signed', async () => {
  const h = await openOutcome();
  expect(h.controller.hasEnteredSigner()).toBe(true);
  h.onSuccess.mockImplementationOnce(async () => {
    await coordinator.sendError(mockRequestRef, 'sign-failed');
  });
  await h.complete();
  expect(h.onSuccess).toHaveBeenCalledTimes(1);
  // Safety net: keep the route mounted as if Error -> Close exposed it.
  await h.freshUnlock();
  jest.spyOn(coordinator, 'isLive').mockReturnValue(false);
  await fireEvent.press(h.signButton());
  expect(Toast.show).not.toHaveBeenCalledWith(
    expect.objectContaining({
      text2: expect.stringContaining('Nothing was signed'),
    })
  );
  expect(h.alert).toHaveBeenCalledWith(
    'Request ended',
    'Check the dApp, then try again there if you still need it.'
  );
});

it.each(['Cancel', 'failure', 'background', 'late Sign'] as const)(
  'U7 remote QR signer exit is terminal and truthful: %s',
  async (exit) => {
    const h = await openOutcome({ remote: true, locked: false });
    await waitFor(() =>
      expect(h.controller.getRemoteSignerRequest()).toBeTruthy()
    );
    if (exit === 'Cancel') {
      await fireEvent.press(h.view.getByText('Cancel'));
      expectEnd('declined');
    } else if (exit === 'failure') {
      await act(async () =>
        h.controller.processRemoteSignerResponse({
          v: 1,
          t: 'res',
          id: 'mismatch',
          ts: 1,
          ok: false,
        })
      );
      expectEnd('sign-failed');
    } else if (exit === 'background') {
      await lapse('background');
      await waitFor(() => expectEnd('lapsed'));
    } else {
      jest.spyOn(coordinator, 'isLive').mockReturnValue(false);
      await fireEvent.press(h.signButton());
      expect(
        require('react-native-toast-message').default.show
      ).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text2: 'Nothing was signed. Try again in the dApp.',
        })
      );
      expect(h.alert).toHaveBeenCalledWith(
        'Request ended',
        'Check the dApp, then try again there if you still need it.'
      );
    }
  }
);

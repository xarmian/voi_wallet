import {
  TransactionAuthController,
  currentController,
  waitFor,
  setupOutcomeHarness,
  openOutcome,
  lapse,
  texts,
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
    expect(h.alert).toHaveBeenLastCalledWith('Request ended', texts.idle);
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
  expect(h.onSuccess).toHaveBeenCalledWith(result);
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
    expect(h.modal().props.visible).toBe(true);
    expect(h.modal().props.message).toBe('');
    await h.complete();
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
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
  expect(h.alert).toHaveBeenCalledWith('Request ended', texts.remote);
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
    expect(h.alert).toHaveBeenCalledWith('Request ended', texts.idle);
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
  expect(h.alert).toHaveBeenCalledWith('Request ended', message);
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
    expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
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
  'ledgerCancelStopsEntriesAfterShownPrompt:locked=%s',
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
// DEFECT for the busy refusal; REGRESSION for signing after the old loop settles.
it.each([true, false])(
  'ledgerNewFlowRefusedWhileOldLoopAlive:locked=%s',
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
    await h.freshUnlock();
    await fireEvent.press(h.signButton());
    await h.ready();
    expect(h.alert).toHaveBeenCalledWith(
      'Ledger busy',
      'Your Ledger is still finishing the previous request. Wait for it to stop, then start the request again.'
    );
    expect(h.deviceSign).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).not.toHaveBeenCalled();
    await act(async () => {
      finish(new Uint8Array([1]));
      await h.signerRuns[0];
    });
    await h.freshUnlock();
    await fireEvent.press(h.signButton());
    await h.ready();
    await act(async () => {
      await h.signerRuns[h.signerRuns.length - 1];
    });
    expect(h.deviceSign).toHaveBeenCalledTimes(4);
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
  }
);

import {
  TransactionAuthController,
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
it.each(['lock', 'background', 'rotation', 'idle'] as const)(
  'lockedLapseShowsExactText:%s',
  async (reason) => {
    const h = await openOutcome();
    await lapse(reason);
    expect(h.modal().props.visible).toBe(true);
    expect(h.modal().props.message).toBe('');
    await h.complete();
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith(
      'Request ended',
      reason === 'idle' ? texts.idle : texts.lock
    );
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
// DEFECT
it.each(Object.entries(texts))(
  'unlockedOutcomeTextsAtTheAlert:%s',
  async (_name, message) => {
    const h = await openOutcome({ locked: false });
    const module = jest.requireActual(
      '@/services/auth/transactionAuthController'
    );
    const ErrorClass = module.ReviewEndedError ?? Error;
    await act(async () => {
      inside(h.controller).updateState({
        state: 'error',
        error: new ErrorClass(message),
      });
    });
    expect(h.alert).toHaveBeenCalledWith('Request ended', message);
    expect(h.onSuccess).not.toHaveBeenCalled();
  }
);
// DEFECT
it.each(['PIN', 'biometric'] as const)(
  'spentLedgerFlowDoesNotRestartOnReady:%s',
  async (method) => {
    const h = await openOutcome({ locked: false, ledger: true });
    await h.ready();
    expect(h.signer).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.callbacks().onError!(new Error('device locked'));
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
// REGRESSION: batch signing returns bytes and never submits a transaction.
it('cancelThenDeviceApprovesSubmitsNothing', async () => {
  const h = await openOutcome({ ledger: true });
  await h.ready();
  await fireEvent.press(h.view.getByText('Cancel'));
  await act(async () => {
    h.callbacks().onNetworkSubmit!();
    h.callbacks().onNetworkConfirmed!('late', true);
  });
  await h.complete();
  expect(h.onSuccess).not.toHaveBeenCalled();
  expect(h.submit).not.toHaveBeenCalled();
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

// DEFECT: a rejected signer promise must preserve the lapse ending too.
it.each(['lock', 'background', 'rotation', 'idle'] as const)(
  'lockedSignerThrowAfterLapseShowsExactText:%s',
  async (reason) => {
    const h = await openOutcome();
    await lapse(reason);
    await h.rejectSigner();
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith(
      'Request ended',
      reason === 'idle' ? texts.idle : texts.lock
    );
    expect(SessionKeyVault.isUnlocked()).toBe(reason === 'rotation');
  }
);

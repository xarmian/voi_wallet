import {
  currentController,
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
  waitFor,
} from './helpers/reviewOutcomeHarness';

setupOutcomeHarness();
const sites = [
  'init-478',
  'remote-529',
  'initCatch-536',
  'onError-1738',
  'lapse-1855',
  'failed-1890',
  'final-1918',
  'pauseFailed-1935',
  'signCatch-1948',
  'cancel-2224',
  'reset-2273',
  'cleanup-2757',
  'modalResetAfterDismiss',
  'grantRefusal',
  'pinPresence',
  'preSigner',
] as const;
// DEFECT: outcomes in a locked sitting must publish before their screen ends it.
// REGRESSION: explicit teardown and normal-unlock delivery retain their existing scope.
it.each(
  sites.flatMap((site) => [false, true].map((locked) => ({ site, locked })))
)('population:$site:locked=$locked', async ({ site, locked }) => {
  if (site === 'grantRefusal')
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
  if (site === 'preSigner')
    (AccountSecureStorage.hasPin as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        inside(
          currentController()
        ).currentRequest!.walletConnectParams!.transactions[0].txn = 'AQ==';
        return true;
      });
  if (site === 'pinPresence')
    (AccountSecureStorage.hasPin as jest.Mock)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
  if (site === 'initCatch-536')
    (AccountSecureStorage.hasPin as jest.Mock).mockResolvedValueOnce(false);
  const ledger = site === 'pauseFailed-1935';
  const remote = site === 'remote-529';
  // Observe real QR initialization; only the remote signer service is stubbed.
  const qr = remote
    ? jest.spyOn(
        require('@/services/auth/transactionAuthController')
          .TransactionAuthController.prototype,
        'initializeRemoteSignerFlow'
      )
    : null;
  const h = await openOutcome({
    locked,
    ledger,
    remote,
    signerThrows: site === 'signCatch-1948',
  });
  const { shownWithVault } = h;
  let delivery = false;
  let message: string | null = null;
  let explicit = false;
  if (site === 'final-1918') {
    await h.complete();
    delivery = true;
  }
  if (site === 'onError-1738') {
    await act(async () => {
      h.callbacks().onError!(new Error('TransactionPool.Remember: overspend'));
    });
    if (!locked) {
      /* The normal-unlock software retry stays PIN-shaped when the signer reports failure. */
    }
    message = 'overspend';
  }
  if (site === 'failed-1890') {
    await act(async () => {
      h.callbacks().onComplete!({
        success: false,
        error: new Error('signing failed'),
      });
    });
    message = 'mapped';
  }
  if (site === 'lapse-1855') {
    await lapse('lock');
    await h.complete();
    message = texts.lock;
  }
  if (site === 'signCatch-1948') message = 'mapped';
  if (site === 'pauseFailed-1935') {
    let rotated = false;
    const stop = h.controller.subscribe((state) => {
      if (state.state === 'signing' && !rotated) {
        rotated = true;
        SessionKeyVault.set('rotated fixture', 'pin');
      }
    });
    await h.ready();
    stop();
    message = texts.unlock;
  }
  if (site === 'initCatch-536' || site === 'pinPresence') message = texts.noPin;
  if (site === 'grantRefusal' || site === 'preSigner') message = texts.unlock;
  if (site === 'remote-529') {
    if (locked) {
      expect(qr).not.toHaveBeenCalled();
      message = texts.remote;
    } else {
      expect(qr).toHaveBeenCalledTimes(1);
      explicit = true;
    }
  }
  if (site === 'init-478') {
    // Replacing an entered request is controller-only: the screen doesn't replace an open modal's request.
    const old = inside(h.controller).currentRequest!;
    await act(async () => {
      void h.controller.initializeSigningFlow({
        ...old,
        reviewGrantKey: undefined,
      });
    });
    explicit = true;
  }
  if (site === 'cancel-2224') {
    await act(async () => {
      h.controller.cancel();
    });
    explicit = true;
  }
  if (site === 'reset-2273') {
    await act(async () => {
      h.controller.resetAfterDismiss();
    });
    explicit = true;
  }
  if (site === 'cleanup-2757') {
    await h.view.unmount();
    explicit = true;
  }
  if (site === 'modalResetAfterDismiss') {
    await act(async () => {
      inside(h.controller).updateState({
        state: 'error',
        error: new Error('signing failed'),
      });
    });
    message = 'mapped';
  }
  expect(h.onSuccess).toHaveBeenCalledTimes(delivery ? 1 : 0);
  if (delivery) expect(h.onSuccess).toHaveBeenCalledWith(result);
  if (message && !['mapped', 'overspend'].includes(message))
    expect(h.alert).toHaveBeenCalledWith('Request ended', message);
  if (message === 'mapped')
    expect(h.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringContaining('signing failed')
    );
  if (site === 'onError-1738')
    expect(h.alert).toHaveBeenCalledWith(
      'Not Enough Balance',
      expect.any(String)
    );
  if (delivery || explicit) expect(h.alert).not.toHaveBeenCalled();
  if (locked && message && site !== 'lapse-1855')
    expect(shownWithVault).toEqual([true]);
  if (locked && site === 'lapse-1855') expect(shownWithVault).toEqual([false]);
  if (site === 'failed-1890' && !locked) {
    expect(SessionKeyVault.isUnlocked()).toBe(true);
  } else
    // lapse-1855 is a lock (the vault is cleared at the event); pauseFailed-1935
    // injects a rotation, and the replacement vault belongs to whoever set it.
    expect(SessionKeyVault.isUnlocked()).toBe(
      site === 'lapse-1855'
        ? false
        : site === 'pauseFailed-1935'
          ? true
          : !locked
    );
  expect(reviewGrant.isValid(key)).toBe(false);
  expect(reviewGrant.isUnspent(key)).toBe(false);
  expect(reviewGrant.pauseIdle(key)).toBe(false);
});

// DEFECT for explicit cancellation and in-app ordering; REGRESSION for delivery after the old run settles.
it.each(
  [false, true].flatMap((locked) =>
    [
      'userCancel-authenticating',
      'ledgerCancel-signing-loop',
      'inApp-completeThenSubmit',
      'newFlow-while-old-loop-alive',
    ]
      .filter((site) => !locked || site !== 'inApp-completeThenSubmit')
      .map((site) => ({ locked, site }))
  )
)('population:$site:locked=$locked', async ({ locked, site }) => {
  const inApp = site === 'inApp-completeThenSubmit';
  const h = await openOutcome({
    locked,
    ledger: !inApp,
    inApp,
    realSigner: !inApp,
    entries: 3,
  });
  if (inApp) {
    let finish!: () => void;
    h.onSuccess.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await h.complete();
    expect(h.modal().props.visible).toBe(false);
    expect(h.onSuccess).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
  } else if (site === 'userCancel-authenticating') {
    await fireEvent.press(h.view.getByText('Cancel'));
  } else {
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
    if (site === 'newFlow-while-old-loop-alive') {
      await h.freshUnlock();
      await fireEvent.press(h.signButton());
      await h.ready();
      expect(h.alert).toHaveBeenCalledWith(
        'Ledger busy',
        'Your Ledger is still finishing the previous request. Wait for it to stop, then start the request again.'
      );
    }
    await act(async () => {
      finish(new Uint8Array([1]));
      await h.signerRuns[0];
    });
    expect(h.deviceSign).toHaveBeenCalledTimes(1);
  }
  expect(h.onSuccess).toHaveBeenCalledTimes(inApp ? 1 : 0);
  if (site !== 'newFlow-while-old-loop-alive')
    expect(h.alert).not.toHaveBeenCalled();
  expect(h.modal().props.visible).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(!locked);
  expect(reviewGrant.isValid(key)).toBe(false);
  expect(reviewGrant.pauseIdle(key)).toBe(false);
});

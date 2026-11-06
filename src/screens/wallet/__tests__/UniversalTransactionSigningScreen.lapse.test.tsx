import {
  setupOutcomeHarness,
  openOutcome,
  lapse,
  texts,
  key,
  inside,
  reviewGrant,
  SessionKeyVault,
  AccountSecureStorage,
  act,
  fireEvent,
  waitFor,
} from './helpers/reviewOutcomeHarness';

setupOutcomeHarness();

const signingState = (controller: Parameters<typeof inside>[0]) =>
  controller as unknown as {
    signingAbortController: AbortController;
    cancelledFlowGeneration: number;
  };

async function pendingLedger(locked = false) {
  const h = await openOutcome({
    locked,
    ledger: true,
    realSigner: true,
    entries: 3,
  });
  let finish!: (bytes: Uint8Array) => void;
  let reject!: (error: Error) => void;
  h.deviceSign.mockImplementationOnce(
    () =>
      new Promise<Uint8Array>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      })
  );
  h.deviceSign.mockResolvedValue(new Uint8Array([1]));
  return {
    ...h,
    finish: async () => {
      await act(async () => {
        finish(new Uint8Array([1]));
        await Promise.allSettled(h.signerRuns);
      });
    },
    rejectDevice: async () => {
      await act(async () => {
        reject(new Error('Transaction rejected by user'));
        await Promise.allSettled(h.signerRuns);
      });
    },
    fail: async () => {
      await act(async () => {
        reject(new Error('communication failed'));
        await Promise.allSettled(h.signerRuns);
      });
    },
  };
}

// DEFECT: a lapse must have the same entry bound as Cancel, while retaining its outcome.
it.each(
  (['lock', 'background', 'rotation'] as const).flatMap((reason) =>
    [true, false].map((locked) => ({ reason, locked }))
  )
)(
  'lapseAbortsLedgerLoop:$reason:locked=$locked',
  async ({ reason, locked }) => {
    const h = await pendingLedger(locked);
    await h.ready();
    await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
    expect(h.controller.getState().signingProgress?.currentStep).toBe(1);
    const abort = jest.spyOn(
      signingState(h.controller).signingAbortController,
      'abort'
    );
    await lapse(reason);
    // More notifications must neither restart the flow nor abort it twice.
    await act(async () => reviewGrant.revoke(false));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.modal().props.visible).toBe(true);
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(SessionKeyVault.isUnlocked()).toBe(
      reason === 'rotation' || (!locked && reason !== 'lock')
    );
    await h.finish();
    expect(h.deviceSign).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
    expect(h.modal().props.visible).toBe(false);
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(reviewGrant.isUnspent(key)).toBe(false);
    expect(SessionKeyVault.isUnlocked()).toBe(
      reason === 'rotation' || (!locked && reason !== 'lock')
    );
  }
);

// REGRESSION: lapses already preserve generation so onComplete can publish the outcome.
it('lapseDoesNotBumpGeneration', async () => {
  const h = await pendingLedger();
  await h.ready();
  await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
  const generation = signingState(h.controller).cancelledFlowGeneration;
  await lapse('background');
  expect(signingState(h.controller).cancelledFlowGeneration).toBe(generation);
  await h.finish();
  expect(h.onSuccess).not.toHaveBeenCalled();
  expect(h.alert).toHaveBeenCalledTimes(1);
  expect(h.alert).toHaveBeenCalledWith('Request ended', expect.any(String));
});

// Observe real subscriptions and their real unsubscribe functions.
function countListeners() {
  const active = new Set<() => void>();
  const subscribe = reviewGrant.subscribe;
  jest.spyOn(reviewGrant, 'subscribe').mockImplementation((listener) => {
    active.add(listener);
    const stop = subscribe(listener);
    return () => {
      active.delete(listener);
      stop();
    };
  });
  return active;
}

// DEFECT: every entered signer owns exactly one temporary lapse subscription.
it.each([
  'success',
  'signer error',
  'user Cancel',
  'cleanup',
  'resetAfterDismiss',
  'flow replacement',
  'signing catch',
] as const)('lapseSubscriptionEndsOnEveryExit:%s', async (exit) => {
  const listeners = countListeners();
  const h = await pendingLedger();
  const before = listeners.size;
  const previousListeners = new Set(listeners);
  const request = {
    ...inside(h.controller).currentRequest!,
    reviewGrantKey: undefined,
  };
  await h.ready();
  await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
  expect(listeners.size).toBe(before + 1);
  const firstSubscription = [...listeners].find(
    (listener) => !previousListeners.has(listener)
  )!;
  const abort = jest.spyOn(
    signingState(h.controller).signingAbortController,
    'abort'
  );
  if (exit === 'user Cancel') await fireEvent.press(h.view.getByText('Cancel'));
  if (exit === 'cleanup') await act(async () => h.controller.cleanup());
  if (exit === 'resetAfterDismiss')
    await act(async () => h.controller.resetAfterDismiss());
  if (exit === 'flow replacement')
    await act(async () => h.controller.initializeSigningFlow(request));
  if (
    [
      'user Cancel',
      'cleanup',
      'resetAfterDismiss',
      'flow replacement',
    ].includes(exit)
  ) {
    expect(listeners.size).toBe(before);
    // A stale listener must not observe the next request while the old device waits.
    const calls = abort.mock.calls.length;
    await act(async () => reviewGrant.revoke(false));
    expect(abort).toHaveBeenCalledTimes(calls);
  }
  let finishDelivery = () => {};
  if (exit === 'success') {
    h.onSuccess.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelivery = resolve;
        })
    );
  }
  let stopThrowing = () => {};
  let callbackThrew = false;
  if (exit === 'signing catch') {
    // A controller state subscriber throws from the signer error callback,
    // exercising the controller catch with the real signer.
    stopThrowing = h.controller.subscribe((state) => {
      if (state.ledgerStatus === 'error' && !callbackThrew) {
        callbackThrew = true;
        throw new Error('callback failed');
      }
    });
  }
  if (exit === 'signer error' || exit === 'signing catch') await h.fail();
  else await h.finish();
  stopThrowing();
  if (exit === 'signing catch') expect(callbackThrew).toBe(true);
  expect(listeners.size).toBe(before);
  expect(listeners.has(firstSubscription)).toBe(false);
  await act(async () => finishDelivery());
  // A second entered signer gets its own subscription on the same controller.
  await h.freshUnlock();
  await act(async () => {
    await h.controller.initializeSigningFlow({
      ...request,
      reviewGrantKey: key,
    });
    expect(reviewGrant.bind(key, inside(h.controller).getReviewDigest()!)).toBe(
      true
    );
    await h.controller.authenticateWithReviewGrant(key);
  });
  let secondFinish!: (bytes: Uint8Array) => void;
  h.deviceSign.mockImplementationOnce(
    () =>
      new Promise<Uint8Array>((resolve) => {
        secondFinish = resolve;
      })
  );
  await h.ready();
  expect(h.deviceSign.mock.calls.length).toBeGreaterThan(1);
  expect(listeners.has(firstSubscription)).toBe(false);
  expect(listeners.size).toBe(before + 1);
  await act(async () => h.controller.cancel({ byUser: true }));
  expect(listeners.size).toBe(before);
  await act(async () => {
    secondFinish(new Uint8Array([1]));
    await Promise.allSettled(h.signerRuns);
  });
  expect(listeners.size).toBe(before);
});

// REGRESSION: failed pauses never enter a signer and must not create a listener.
it('lapseSubscriptionEndsOnEveryExit:pause failed', async () => {
  const listeners = countListeners();
  const h = await pendingLedger();
  const before = listeners.size;
  const countsAtFailure: number[] = [];
  const stop = h.controller.subscribe((state) => {
    if (state.state === 'error') countsAtFailure.push(listeners.size);
    if (state.state === 'signing')
      SessionKeyVault.set('replacement fixture', 'pin');
  });
  await h.ready();
  stop();
  expect(h.deviceSign).not.toHaveBeenCalled();
  expect(countsAtFailure).toEqual([before]);
  expect(listeners.size).toBe(before);
  expect(h.alert).toHaveBeenCalledWith('Request ended', texts.unlock);
  await h.freshUnlock();
  h.deviceSign.mockReset().mockImplementation(async () => {
    expect(listeners.size).toBe(before + 1);
    return new Uint8Array([1]);
  });
  await fireEvent.press(h.signButton());
  await h.ready();
  await act(async () => {
    await Promise.all(h.signerRuns);
  });
  expect(h.onSuccess).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(before);
});

// REGRESSION: only the request's key controls its signer; another key can lapse independently.
it('lapseOnOtherKeyDoesNotAbort', async () => {
  const h = await openOutcome({
    locked: false,
    ledger: true,
    realSigner: true,
    entries: 3,
    sign: false,
    waitingKeys: [key, 'other'],
  });
  await fireEvent.press(h.signButton());
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
  const signal = signingState(h.controller).signingAbortController.signal;
  await act(async () => reviewGrant.leave('other'));
  expect(reviewGrant.isValid('other')).toBe(false);
  expect(reviewGrant.isValid(key)).toBe(true);
  expect(signal.aborted).toBe(false);
  await act(async () => {
    finish(new Uint8Array([1]));
    await Promise.all(h.signerRuns);
  });
  expect(h.deviceSign).toHaveBeenCalledTimes(3);
  expect(h.onSuccess).toHaveBeenCalledTimes(1);
  expect(h.alert).not.toHaveBeenCalled();
});

// DEFECT: both native background listeners can revoke during the same event.
// REGRESSION for unlocked background/rotation: cancel already clears the request key.
it.each(
  (['background', 'lock', 'rotation'] as const).flatMap((reason) =>
    [true, false].map((locked) => ({ reason, locked }))
  )
)(
  'backgroundBeforeSignerAlertsOnce:$reason:locked=$locked',
  async ({ reason, locked }) => {
    const h = await openOutcome({ locked, ledger: true, realSigner: true });
    expect(h.controller.getState().state).toBe('authenticating');
    const cancel = jest.spyOn(h.controller, 'cancel');
    await lapse(reason);
    // Later emits belong to the same ended flow.
    await act(async () => reviewGrant.revoke(false));
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.modal().props.visible).toBe(false);
    expect(h.deviceSign).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(
      reason === 'rotation' || (!locked && reason !== 'lock')
    );
  }
);

// DEFECT: a published device rejection must survive later grant notifications.
it('deviceRejectionStaysOnDThroughLaterEmit', async () => {
  const h = await pendingLedger(true);
  await h.ready();
  await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
  // Drive the real device rejection callback through the real signer.
  await h.rejectDevice();
  const assertD = () => {
    expect(h.view.getByText('Transaction Cancelled')).toBeTruthy();
    expect(
      h.view.getByText('You rejected this transaction on your Ledger device.')
    ).toBeTruthy();
    expect(h.modal().props.visible).toBe(true);
  };
  assertD();
  await lapse('background');
  await act(async () => reviewGrant.revoke(false));
  expect(h.alert).not.toHaveBeenCalled();
  expect(h.onSuccess).not.toHaveBeenCalled();
  assertD();
  await fireEvent.press(h.view.getByText('Close'));
  expect(h.modal().props.visible).toBe(false);
});

// REGRESSION: rejecting the entered entry truthfully shows D even after a lapse.
it('lapseThenDeviceRejectionShowsD', async () => {
  const h = await pendingLedger(true);
  await h.ready();
  await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
  await lapse('background');
  await h.rejectDevice();
  expect(h.view.getByText('Transaction Cancelled')).toBeTruthy();
  expect(
    h.view.getByText('You rejected this transaction on your Ledger device.')
  ).toBeTruthy();
  expect(h.modal().props.visible).toBe(true);
  expect(h.alert).not.toHaveBeenCalled();
  expect(h.onSuccess).not.toHaveBeenCalled();
  expect(h.deviceSign).toHaveBeenCalledTimes(1);
});

// DEFECT: a pending caller rejection must block every later Sign tap.
it.each([true, false])('rejectBlocksLaterSign:locked=%s', async (locked) => {
  const h = await openOutcome({ locked, sign: false });
  let finishReject!: () => void;
  h.onReject.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishReject = resolve;
      })
  );
  const initialize = jest.spyOn(h.controller, 'initializeSigningFlow');
  expect(reviewGrant.isUnspent(key)).toBe(true);
  let rejection!: Promise<void>;
  // Native presses do not await an async onPress handler before the next tap.
  await act(async () => {
    rejection = fireEvent.press(h.view.getByText('Reject'));
  });
  expect(h.onReject).toHaveBeenCalledTimes(1);
  await fireEvent.press(h.signButton());
  expect(initialize).not.toHaveBeenCalled();
  expect(h.modal().props.visible).toBe(false);
  expect(h.signer).not.toHaveBeenCalled();
  await act(async () => {
    finishReject();
    await rejection;
  });
});

// REGRESSION: the post-loop abort check already distinguishes E from B.
it.each([3, 1])('lapseDuringLastEntryShowsE:entries=%s', async (entries) => {
  const h = await openOutcome({
    locked: true,
    ledger: true,
    realSigner: true,
    entries,
  });
  let finish!: (bytes: Uint8Array) => void;
  h.deviceSign.mockImplementation(async () => {
    if (h.deviceSign.mock.calls.length === entries)
      return new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      });
    return new Uint8Array([1]);
  });
  await h.ready();
  await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(entries));
  await lapse('background');
  await act(async () => {
    finish(new Uint8Array([1]));
    await Promise.all(h.signerRuns);
  });
  expect(h.alert).toHaveBeenCalledTimes(1);
  expect(h.alert).toHaveBeenCalledWith('Request ended', texts.lock);
  expect(h.alert).not.toHaveBeenCalledWith('Request ended', texts.batch);
  expect(h.onSuccess).not.toHaveBeenCalled();
  expect(h.modal().props.visible).toBe(false);
});

// DEFECT: cleanup during planning must stop parallel key access and signing.
it('abortBeforeParallelStartSignsNothing', async () => {
  const h = await openOutcome({ locked: true, realSigner: true, sign: false });
  const signer = jest
    .requireActual('@/services/transactions/unifiedSigner')
    .UnifiedTransactionSigner.getInstance();
  const plan = signer.planBatch.bind(signer);
  const planning = jest
    .spyOn(signer, 'planBatch')
    .mockImplementationOnce(async (request) => {
      const plans = await plan(request);
      expect(h.controller.getState().state).toBe('signing');
      h.controller.cleanup();
      return plans;
    });
  const readKey = jest.spyOn(AccountSecureStorage, 'getPrivateKey');
  h.deviceSign.mockImplementation(async () => {
    await AccountSecureStorage.getPrivateKey('account');
    return new Uint8Array([1]);
  });
  try {
    await fireEvent.press(h.signButton());
    await act(async () => {
      await Promise.all(h.signerRuns);
    });
    expect(planning).toHaveBeenCalledTimes(1);
    expect(readKey).not.toHaveBeenCalled();
    expect(h.deviceSign).not.toHaveBeenCalled();
    expect(h.onSuccess).not.toHaveBeenCalled();
  } finally {
    planning.mockRestore();
  }
});

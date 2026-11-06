import {
  setupOutcomeHarness,
  openOutcome,
  openNonBatchOutcome,
  lapse,
  texts,
  key,
  inside,
  reviewGrant,
  SessionKeyVault,
  act,
  fireEvent,
  waitFor,
} from './helpers/reviewOutcomeHarness';

setupOutcomeHarness();

// Routes reduced from grep -rn over src for cancel(), cancelByUser,
// resetAfterDismiss, onCancel, onRequestClose, reviewGrant.leave,
// endReviewCapability and settleReviewCapability, excluding __tests__.
const routes = [
  'modalCancel',
  'systemClose',
  'screenReject',
  'screenLeave',
  'listenerLapse',
  'lock',
  'background',
  'rotation',
  'cleanup',
  'replacement',
  'deviceReject',
  'idle',
] as const;

// REGRESSION: use the real batch loop for both Ledger and software paths.
it.each(
  routes.flatMap((route) =>
    [true, false].flatMap((ledger) =>
      [true, false].map((locked) => ({ route, ledger, locked }))
    )
  )
)(
  'cancelPopulation:$route:batch:ledger=$ledger:locked=$locked',
  async ({ route, ledger, locked }) => {
    const preSigner = route === 'screenReject' || route === 'idle';
    const h = await openOutcome({
      locked,
      ledger,
      realSigner: true,
      entries: 3,
      sign: ledger && route !== 'screenReject',
    });
    const releases: ((bytes: Uint8Array) => void)[] = [];
    let reject!: (error: Error) => void;
    // Software signing starts from the modal effect, so install the deferred
    // leaf before opening its modal by starting in review for that path.
    if (!ledger && !preSigner && h.deviceSign.mock.calls.length > 0)
      throw new Error('software leaf must be installed before signer entry');
    h.deviceSign.mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve, fail) => {
          releases.push(resolve);
          reject = fail;
        })
    );
    if (preSigner) {
      if (route === 'screenReject') {
        await fireEvent.press(h.view.getByText('Reject'));
        expect(h.onReject).toHaveBeenCalledTimes(1);
        expect(SessionKeyVault.isUnlocked()).toBe(true);
        // The caller navigates away on Reject; teardown owns the final leave.
        await h.view.unmount();
      } else {
        await act(async () => jest.advanceTimersByTime(61_000));
        if (ledger)
          expect(h.alert).toHaveBeenCalledWith('Request ended', texts.idle);
        else expect(h.alert).not.toHaveBeenCalled();
      }
      expect(h.deviceSign).not.toHaveBeenCalled();
      expect(h.onSuccess).not.toHaveBeenCalled();
      expect(SessionKeyVault.isUnlocked()).toBe(!locked);
      return;
    }
    if (ledger) await h.ready();
    else await fireEvent.press(h.signButton());
    await waitFor(() =>
      expect(h.deviceSign).toHaveBeenCalledTimes(ledger ? 1 : 3)
    );
    // Capture every already-started parallel software entry.
    const pending = h.deviceSign.mock.results.map((result) => result.value);
    const noSoftwareAction =
      !ledger && ['modalCancel', 'systemClose', 'deviceReject'].includes(route);
    if (route === 'modalCancel') {
      if (ledger) await fireEvent.press(h.view.getByText('Cancel'));
      else expect(h.view.queryByText('Cancel')).toBeNull();
    }
    if (route === 'systemClose') await h.systemBack();
    if (route === 'deviceReject' && ledger)
      await act(async () => reject(new Error('Transaction rejected by user')));
    if (route === 'screenLeave') {
      await h.leave();
      await h.view.unmount();
    }
    if (route === 'listenerLapse')
      await act(async () => reviewGrant.leave(key));
    if (route === 'lock' || route === 'background' || route === 'rotation')
      await lapse(route);
    if (route === 'cleanup') await act(async () => h.controller.cleanup());
    if (route === 'replacement')
      await act(async () =>
        h.controller.initializeSigningFlow({
          ...inside(h.controller).currentRequest!,
          reviewGrantKey: undefined,
        })
      );
    if (noSoftwareAction) {
      expect(h.controller.getState().state).toBe('signing');
      expect(h.modal().props.visible).toBe(true);
    }
    const immediateAbort =
      [
        'modalCancel',
        'systemClose',
        'screenLeave',
        'cleanup',
        'replacement',
      ].includes(route) && !noSoftwareAction;
    expect(h.onSuccess).not.toHaveBeenCalled();
    if (['listenerLapse', 'lock', 'background', 'rotation'].includes(route)) {
      expect(h.alert).not.toHaveBeenCalled();
      expect(h.modal().props.visible).toBe(true);
    }
    if (ledger && ['modalCancel', 'systemClose'].includes(route))
      expect(h.modal().props.visible).toBe(false);
    if (route === 'cleanup' || route === 'replacement') {
      expect(h.modal().props.visible).toBe(true);
      expect(h.controller.getState().state).toBe(
        route === 'cleanup' ? 'idle' : 'authenticating'
      );
    }
    expect(SessionKeyVault.isUnlocked()).toBe(
      noSoftwareAction || route === 'rotation' || (!locked && route !== 'lock')
    );
    // Only the entry whose phone prompt was shown can still reach the device
    // after abort. A lapse without cancel does not abort an entered signer.
    h.deviceSign.mockResolvedValue(new Uint8Array([1]));
    await act(async () => {
      if (!(route === 'deviceReject' && ledger)) {
        for (const finish of releases) finish(new Uint8Array([1]));
      }
      await Promise.allSettled(pending);
      await Promise.all(h.signerRuns);
    });
    expect(h.deviceSign).toHaveBeenCalledTimes(
      ledger && (immediateAbort || route === 'deviceReject') ? 1 : 3
    );
    expect(h.onSuccess).toHaveBeenCalledTimes(noSoftwareAction ? 1 : 0);
    const lapsed = ['listenerLapse', 'lock', 'background', 'rotation'].includes(
      route
    );
    if (lapsed)
      expect(h.alert).toHaveBeenCalledWith('Request ended', texts.batch);
    else expect(h.alert).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(
      route === 'rotation' || (!locked && route !== 'lock')
    );
    if (route === 'deviceReject' && ledger) {
      expect(h.view.getByText('Transaction Cancelled')).toBeTruthy();
      expect(
        h.view.getByText('You rejected this transaction on your Ledger device.')
      ).toBeTruthy();
    }
  }
);

// REGRESSION: the shared modal also serves non-batch caller screens. Those
// requests have no reviewGrantKey and cannot be locked review sittings here.
const types = ['voi_transfer', 'rekey', 'keyreg', 'appl'] as const;
it.each(
  types.flatMap((type) =>
    routes.flatMap((route) =>
      [true, false].map((ledger) => ({ type, route, ledger }))
    )
  )
)(
  'cancelPopulation:$route:$type:ledger=$ledger',
  async ({ type, route, ledger }) => {
    const h = await openNonBatchOutcome(type, ledger, false);
    expect(h.request.reviewGrantKey).toBeUndefined();
    const finishes: ((bytes: Uint8Array) => void)[] = [];
    let reject!: (error: Error) => void;
    h.deviceSign.mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve, fail) => {
          finishes.push(resolve);
          reject = fail;
        })
    );
    if (route === 'idle') {
      await act(async () => jest.advanceTimersByTime(61_000));
      expect(h.deviceSign).not.toHaveBeenCalled();
      expect(h.modal().props.visible).toBe(true);
      expect(SessionKeyVault.isUnlocked()).toBe(true);
      return;
    }
    if (route === 'screenReject' || route === 'listenerLapse') {
      // UniversalTransactionSigningScreen always constructs a batch request;
      // neither its Reject handler nor its grant listener owns this modal.
      expect(h.view.queryByText('Reject')).toBeNull();
      await act(async () => reviewGrant.leave(key));
      expect(h.controller.getState().state).toBe('authenticating');
      expect(h.deviceSign).not.toHaveBeenCalled();
      expect(h.modal().props.visible).toBe(true);
      return;
    }
    await h.begin();
    await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
    if (route === 'modalCancel' || route === 'systemClose') {
      // In normal device wait the non-batch modal offers no Cancel. The
      // error/app_required exception is tested separately below.
      expect(h.view.queryByText('Cancel')).toBeNull();
      await h.systemBack();
      expect(h.controller.getState().state).toBe('signing');
    }
    if (route === 'screenLeave') {
      await h.view.unmount();
      await act(async () => h.controller.cleanup());
    }
    if (route === 'lock' || route === 'background' || route === 'rotation')
      await lapse(route);
    if (route === 'cleanup') await act(async () => h.controller.cleanup());
    if (route === 'replacement')
      await act(async () => h.controller.initializeSigningFlow(h.request));
    if (route === 'deviceReject' && ledger)
      await act(async () => reject(new Error('Transaction rejected by user')));
    if (route === 'deviceReject' && !ledger)
      expect(h.controller.getState().isLedgerFlow).toBe(false);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onSuccess).not.toHaveBeenCalled();
    const discarded =
      ['screenLeave', 'cleanup', 'replacement'].includes(route) ||
      (route === 'deviceReject' && ledger);
    await act(async () => {
      finishes.forEach((finish) => finish(new Uint8Array([1])));
      await Promise.all(h.signerRuns);
    });
    // TASK-526: non-batch submit has no AbortSignal. Even a cleanup cannot
    // recall an entry already inside TransactionService.sendTransaction.
    expect(h.submit).toHaveBeenCalledTimes(
      route === 'deviceReject' && ledger ? 0 : 1
    );
    expect(h.onSuccess).toHaveBeenCalledTimes(discarded ? 0 : 1);
    expect(h.alert).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(true);
  }
);

// REGRESSION: pin the pre-existing error/app-required window, including the
// submit that continues after the modal closes (TASK-526).
it.each(
  types.flatMap((type) =>
    ['error', 'app_required'].flatMap((status) =>
      ['button', 'close'].map((exit) => ({ type, status, exit }))
    )
  )
)(
  'cancelPopulation:nonBatchException:$type:$status:$exit',
  async ({ type, status, exit }) => {
    const h = await openNonBatchOutcome(type, true, false);
    let release!: (bytes: Uint8Array) => void;
    h.deviceSign.mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve;
        })
    );
    await h.begin();
    await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
    await act(async () =>
      inside(h.controller).updateState({ ledgerStatus: status })
    );
    if (exit === 'button') await fireEvent.press(h.view.getByText('Cancel'));
    else await h.systemBack();
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.modal().props.visible).toBe(false);
    await act(async () => {
      release(new Uint8Array([1]));
      await Promise.all(h.signerRuns);
    });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(true);
  }
);

import {
  setupOutcomeHarness,
  openOutcome,
  openNonBatchOutcome,
  lapse,
  inside,
  SessionKeyVault,
  act,
  fireEvent,
  waitFor,
} from './helpers/reviewOutcomeHarness';

setupOutcomeHarness();

// REGRESSION: batch Reject and software review idle remain separate from the entered routes.
// Ledger idle with the modal open is retained in the scoped pre-signer population.
const routes = ['screenReject', 'idle'] as const;
// Use the real batch loop for both Ledger and software paths.
it.each(
  routes.flatMap((route) =>
    (route === 'idle' ? [false] : [true, false]).flatMap((ledger) =>
      [true, false].map((locked) => ({ route, ledger, locked }))
    )
  )
)(
  'cancelPopulation:$route:batch:ledger=$ledger:locked=$locked',
  async ({ route, ledger, locked }) => {
    const h = await openOutcome({
      locked,
      ledger,
      realSigner: true,
      entries: 3,
      sign: false,
    });
    if (route === 'screenReject') {
      await fireEvent.press(h.view.getByText('Reject'));
      expect(h.onReject).toHaveBeenCalledTimes(1);
      expect(SessionKeyVault.isUnlocked()).toBe(true);
      // The caller navigates away on Reject; teardown owns the final leave.
      await h.view.unmount();
    } else {
      await act(async () => jest.advanceTimersByTime(61_000));
      expect(h.alert).not.toHaveBeenCalled();
    }
    expect(SessionKeyVault.isUnlocked()).toBe(!locked);
  }
);

// REGRESSION: the shared modal also serves non-batch caller screens. Those
// requests have no reviewGrantKey and cannot be locked review sittings here.
const types = ['voi_transfer', 'rekey', 'keyreg', 'appl'] as const;
it.each(
  types.flatMap((type) =>
    (
      [
        'systemClose',
        'lock',
        'background',
        'rotation',
        'cleanup',
        'replacement',
        'deviceReject',
      ] as const
    ).flatMap((route) =>
      (route === 'deviceReject' ? [true] : [true, false]).map((ledger) => ({
        type,
        route,
        ledger,
      }))
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
    await h.begin();
    await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
    if (route === 'systemClose') {
      // In normal device wait the non-batch modal offers no Cancel. The
      // error/app_required exception is tested separately below.
      expect(h.view.queryByText('Cancel')).toBeNull();
      await h.systemBack();
      expect(h.controller.getState().state).toBe('signing');
    }
    if (route === 'lock' || route === 'background' || route === 'rotation')
      await lapse(route);
    if (route === 'cleanup') await act(async () => h.controller.cleanup());
    if (route === 'replacement')
      await act(async () => h.controller.initializeSigningFlow(h.request));
    if (route === 'deviceReject' && ledger)
      await act(async () => reject(new Error('Transaction rejected by user')));
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onSuccess).not.toHaveBeenCalled();
    const discarded =
      ['cleanup', 'replacement'].includes(route) ||
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

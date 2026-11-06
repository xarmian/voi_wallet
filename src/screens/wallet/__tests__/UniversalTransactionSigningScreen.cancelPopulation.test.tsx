import {
  setupOutcomeHarness,
  openOutcome,
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

// Only requests holding a review capability are in this population.
// L = locked review sitting; U = unlocked wallet WITH A MINTED GRANT.
// Cancel and a lapse abort the Ledger loop before its next entry.
// For software, the pre-parallel check sees Cancel and cleanup, not a lapse.
// A software lapse only withholds delivery via onComplete's grant re-check;
// the window between pauseIdle and the parallel branch is not covered.
const routes = [
  'modalCancel',
  'systemClose',
  'screenLeave',
  'listenerLapse',
  'lock',
  'background',
  'rotation',
  'cleanup',
  'replacement',
  'deviceReject',
] as const;

// REGRESSION: the existing entered-signer routes retain their bounds and outcomes.
// Use the real batch loop for both Ledger and software paths.
it.each(
  routes.flatMap((route) =>
    (route === 'deviceReject' ? [true] : [true, false]).flatMap((ledger) =>
      [true, false].map((locked) => ({
        route,
        ledger,
        locked,
        caseName:
          !ledger && ['modalCancel', 'systemClose'].includes(route)
            ? `softwareNoCancelInSigningDeliversNormally:${route}`
            : `cancelPopulation:${route}`,
      }))
    )
  )
)(
  '$caseName:batch:ledger=$ledger:locked=$locked',
  async ({ route, ledger, locked }) => {
    const h = await openOutcome({
      locked,
      ledger,
      realSigner: true,
      entries: 3,
      sign: ledger,
    });
    const releases: ((bytes: Uint8Array) => void)[] = [];
    let reject!: (error: Error) => void;
    // Software signing starts from the modal effect, so install the deferred
    // leaf before opening its modal by starting in review for that path.
    if (!ledger && h.deviceSign.mock.calls.length > 0)
      throw new Error('software leaf must be installed before signer entry');
    h.deviceSign.mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve, fail) => {
          releases.push(resolve);
          reject = fail;
        })
    );
    if (ledger) await h.ready();
    else await fireEvent.press(h.signButton());
    await waitFor(() =>
      expect(h.deviceSign).toHaveBeenCalledTimes(ledger ? 1 : 3)
    );
    // Capture every already-started parallel software entry.
    const pending = h.deviceSign.mock.results.map((result) => result.value);
    const noSoftwareAction =
      !ledger && ['modalCancel', 'systemClose'].includes(route);
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
        'listenerLapse',
        'lock',
        'background',
        'rotation',
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
    // After Cancel or a lapse, no entry starts after the one the loop entered;
    // that entry can still resolve, and its signature is discarded.
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
    // A Ledger loop is aborted before it signals completion; a software batch has
    // already signed every entry in parallel, so its text is unchanged.
    if (lapsed)
      expect(h.alert).toHaveBeenCalledWith(
        'Request ended',
        ledger ? texts.lock : texts.batch
      );
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

// DEFECT for locked background alerts; REGRESSION for the other pre-signer boundaries.
it.each(
  (
    ['lock', 'background', 'rotation', 'listenerLapse', 'idle'] as const
  ).flatMap((route) =>
    [true, false].flatMap((ledger) =>
      [true, false].map((locked) => ({ route, ledger, locked }))
    )
  )
)(
  'cancelPopulation:beforeSigner:$route:ledger=$ledger:locked=$locked',
  async ({ route, ledger, locked }) => {
    const h = await openOutcome({
      locked,
      ledger,
      realSigner: true,
      sign: false,
    });
    // Hold the software authentication handoff before signer entry, as Ledger discovery does.
    if (!ledger)
      jest.spyOn(inside(h.controller), 'startSigning').mockResolvedValue();
    await fireEvent.press(h.signButton());
    expect(h.modal().props.visible).toBe(true);
    expect(reviewGrant.isValid(key)).toBe(true);
    if (route === 'idle')
      await act(async () => jest.advanceTimersByTime(61_000));
    else if (route === 'listenerLapse')
      await act(async () => reviewGrant.leave(key));
    else await lapse(route);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith(
      'Request ended',
      route === 'idle' ? texts.idle : texts.lock
    );
    expect(h.modal().props.visible).toBe(false);
    expect(h.deviceSign).not.toHaveBeenCalled();
    expect(h.onSuccess).not.toHaveBeenCalled();
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(SessionKeyVault.isUnlocked()).toBe(
      route === 'rotation' || (!locked && route !== 'lock')
    );
  }
);

/**
 * useBottomSheetModalVisibility tests (TASK-432).
 *
 * The fake modal below models the @gorhom/bottom-sheet 5.2.14 status machine
 * that wedges (gorhom/react-native-bottom-sheet#2669): a dismiss() while the
 * status is INITIAL latches DISMISSING, and present() is a silent no-op from
 * then on. Each case drives the hook through a real visibility sequence and
 * asserts the sheet still opens. The "unguarded" case shows the fake can go
 * red: the old `isVisible ? present() : dismiss()` effect wedges it.
 */

import { useEffect, useRef } from 'react';
import { act, renderHook } from '@testing-library/react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

import { useBottomSheetModalVisibility } from '../useBottomSheetModalVisibility';

type Status = 'INITIAL' | 'PRESENTED' | 'DISMISSING';

class FakeModal {
  status: Status = 'INITIAL';
  opens = 0;
  onDismiss: () => void = () => {};

  present() {
    // handlePortalRender bails while DISMISSING, so the sheet never mounts.
    if (this.status === 'DISMISSING') return;
    this.status = 'PRESENTED';
    this.opens += 1;
  }

  dismiss() {
    // handleDismiss has no INITIAL early exit: it latches DISMISSING and
    // forceClose() hits a null sheet ref, so nothing completes the dismissal.
    if (this.status === 'INITIAL') {
      this.status = 'DISMISSING';
      return;
    }
    if (this.status === 'PRESENTED') this.close();
  }

  /** The close animation finishing (programmatic dismiss or pan-down). */
  close() {
    // unmount(): resetVariables() back to INITIAL, then onDismiss.
    this.status = 'INITIAL';
    this.onDismiss();
  }
}

function asRef(modal: FakeModal) {
  return { current: modal as unknown as BottomSheetModal };
}

function renderGuarded(modal: FakeModal, initial: boolean) {
  return renderHook(
    ({ visible }: { visible: boolean }) => {
      const ref = useRef(asRef(modal)).current;
      const { onDismiss } = useBottomSheetModalVisibility(ref, visible);
      modal.onDismiss = onDismiss;
    },
    { initialProps: { visible: initial } }
  );
}

describe('useBottomSheetModalVisibility', () => {
  it('opens a sheet that mounted hidden', async () => {
    const modal = new FakeModal();
    const { rerender } = await renderGuarded(modal, false);

    expect(modal.status).toBe('INITIAL');
    await rerender({ visible: true });
    expect(modal.opens).toBe(1);
  });

  it('reopens after a programmatic close', async () => {
    const modal = new FakeModal();
    const { rerender } = await renderGuarded(modal, false);

    await rerender({ visible: true });
    await rerender({ visible: false });
    expect(modal.status).toBe('INITIAL');
    await rerender({ visible: true });
    expect(modal.opens).toBe(2);
  });

  it('reopens after a user close (pan-down/backdrop) that the parent mirrors', async () => {
    const modal = new FakeModal();
    const { rerender } = await renderGuarded(modal, false);

    await rerender({ visible: true });
    // The library closes and unmounts on its own, then onChange(-1) makes the
    // parent flip isVisible to false.
    await act(async () => modal.close());
    await rerender({ visible: false });
    expect(modal.status).toBe('INITIAL');
    await rerender({ visible: true });
    expect(modal.opens).toBe(2);
  });

  it('the unguarded effect wedges the fake (the instrument can go red)', async () => {
    const modal = new FakeModal();
    const { rerender } = await renderHook(
      ({ visible }: { visible: boolean }) => {
        const ref = useRef(asRef(modal)).current;
        useEffect(() => {
          if (visible) ref.current?.present();
          else ref.current?.dismiss();
        }, [visible, ref]);
      },
      { initialProps: { visible: false } }
    );

    await rerender({ visible: true });
    expect(modal.status).toBe('DISMISSING');
    expect(modal.opens).toBe(0);
  });
});

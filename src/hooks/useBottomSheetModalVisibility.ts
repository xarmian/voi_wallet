/**
 * useBottomSheetModalVisibility — drive a `BottomSheetModal` from an
 * `isVisible` prop without wedging it (TASK-432).
 *
 * @gorhom/bottom-sheet 5.2.10+ breaks the obvious declarative wrapper
 * (`isVisible ? present() : dismiss()` in an effect). A `dismiss()` that lands
 * while the modal's internal status is INITIAL latches DISMISSING and nothing
 * ever moves it back, so every later `present()` is silently dropped: the
 * sheet never opens again. Upstream: gorhom/react-native-bottom-sheet#2669
 * (open as of 5.2.14). The status is INITIAL before the first present, after
 * every close (unmount resets it), and for the frames between `present()` and
 * the open animation starting (`present()` defers its work to a frame).
 *
 * So this hook tracks the library's lifecycle and only acts from a settled
 * phase:
 *   closed     --present()-->  presenting
 *   presenting --onChange to an open index-->  open
 *   open       --dismiss()-->  closing
 *   closing    --onChange to an open index-->  open (the close was a no-op)
 *   any        --onDismiss-->  closed
 * A visibility change that arrives mid-transition (presenting or closing) is
 * held and applied when the transition lands, never fired into the gap.
 *
 * "Open" means the open animation has SETTLED (onChange), not started
 * (onAnimate): a forceClose() issued before the sheet has moved off its closed
 * position is a no-op in the library, the open then completes, and no close
 * callback ever arrives. Dismissing from a settled position always animates.
 * If a sheet nonetheless settles open while we are closing, the close was a
 * no-op, so the hook re-enters open and reconciles again.
 *
 * A held show is applied a render after onDismiss, not inside it: the
 * wrappers turn the close's onChange(-1) into isVisible=false in the same
 * batch, and presenting before that lands would flash the sheet open.
 *
 * Supported configuration: the library defaults animateOnMount=true and
 * enableDismissOnClose=true. With animateOnMount=false the open emits no
 * onChange, and with enableDismissOnClose=false a close never fires onDismiss,
 * so either would strand the phase.
 *
 * Callers pass `onDismiss` to the modal and call `onChange` from their own
 * `onChange` handler.
 */

import { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

type Phase = 'closed' | 'presenting' | 'open' | 'closing';

export interface BottomSheetModalVisibility {
  onChange: (index: number) => void;
  onDismiss: () => void;
}

export function useBottomSheetModalVisibility(
  sheetRef: RefObject<BottomSheetModal | null>,
  isVisible: boolean
): BottomSheetModalVisibility {
  const phaseRef = useRef<Phase>('closed');
  const wantedRef = useRef(isVisible);
  // Bumped on onDismiss so the next reconcile runs after a render, by which
  // point a parent that mirrored the close into isVisible=false has landed.
  const [dismissals, setDismissals] = useState(0);

  const reconcile = useCallback(() => {
    if (wantedRef.current && phaseRef.current === 'closed') {
      phaseRef.current = 'presenting';
      sheetRef.current?.present();
    } else if (!wantedRef.current && phaseRef.current === 'open') {
      phaseRef.current = 'closing';
      sheetRef.current?.dismiss();
    }
  }, [sheetRef]);

  useEffect(() => {
    wantedRef.current = isVisible;
    reconcile();
  }, [isVisible, dismissals, reconcile]);

  const onChange = useCallback(
    (index: number) => {
      if (index >= 0 && phaseRef.current !== 'closed') {
        phaseRef.current = 'open';
        reconcile();
      }
    },
    [reconcile]
  );

  const onDismiss = useCallback(() => {
    phaseRef.current = 'closed';
    setDismissals((n) => n + 1);
  }, []);

  return { onChange, onDismiss };
}

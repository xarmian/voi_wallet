/**
 * useBottomSheetModalVisibility — drive a `BottomSheetModal` from an
 * `isVisible` prop without wedging it (TASK-432).
 *
 * @gorhom/bottom-sheet 5.2.10+ breaks the obvious declarative wrapper
 * (`isVisible ? present() : dismiss()` in an effect). A `dismiss()` that lands
 * while the modal's internal status is INITIAL (never presented, or already
 * unmounted after a close) sets the status to DISMISSING and nothing ever moves
 * it back, so every later `present()` is silently dropped: the sheet never
 * opens again. Upstream: gorhom/react-native-bottom-sheet#2669 (open as of
 * 5.2.14). A modal mounted with `isVisible=false` hits this on first render.
 *
 * The guard: only call `dismiss()` on a modal this hook presented and that has
 * not reported `onDismiss` since. `onDismiss` fires from the library's
 * unmount, right after it resets the status to INITIAL, so clearing the flag
 * there keeps a later `isVisible=false` from dismissing an INITIAL modal.
 *
 * Callers pass the returned `onDismiss` to the modal's `onDismiss` prop.
 */

import { RefObject, useCallback, useEffect, useRef } from 'react';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

export function useBottomSheetModalVisibility(
  sheetRef: RefObject<BottomSheetModal | null>,
  isVisible: boolean
): { onDismiss: () => void } {
  const presentedRef = useRef(false);

  useEffect(() => {
    if (isVisible) {
      presentedRef.current = true;
      sheetRef.current?.present();
    } else if (presentedRef.current) {
      presentedRef.current = false;
      sheetRef.current?.dismiss();
    }
  }, [isVisible, sheetRef]);

  const onDismiss = useCallback(() => {
    presentedRef.current = false;
  }, []);

  return { onDismiss };
}

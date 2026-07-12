/**
 * Thin, safe wrapper around expo-haptics.
 *
 * Every call is fire-and-forget: haptics are cosmetic feedback and must never
 * surface an error to the user. The native module rejects on hardware without a
 * haptic engine and is unavailable on the web/extension target, so we guard on
 * platform and swallow any rejection. Centralizing the calls here also keeps the
 * ImpactFeedbackStyle / NotificationFeedbackType mapping in one place.
 */
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

// Only iOS and Android have a haptic engine; react-native-web (extension/web
// target) does not, so no-op there rather than importing native behavior.
const isSupported = Platform.OS === 'ios' || Platform.OS === 'android';

export type HapticImpactStyle = 'light' | 'medium' | 'heavy';
export type HapticNotifyType = 'success' | 'warning' | 'error';

/** Light/medium/heavy tap — use for button presses and discrete selections. */
export function hapticImpact(style: HapticImpactStyle = 'light'): void {
  if (!isSupported) return;
  const impactStyle =
    style === 'heavy'
      ? Haptics.ImpactFeedbackStyle.Heavy
      : style === 'medium'
        ? Haptics.ImpactFeedbackStyle.Medium
        : Haptics.ImpactFeedbackStyle.Light;
  Haptics.impactAsync(impactStyle).catch(() => {});
}

/** Success/warning/error notification — use for operation outcomes. */
export function hapticNotify(type: HapticNotifyType): void {
  if (!isSupported) return;
  const notifyType =
    type === 'success'
      ? Haptics.NotificationFeedbackType.Success
      : type === 'warning'
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Error;
  Haptics.notificationAsync(notifyType).catch(() => {});
}

/** Selection tick — use for pickers / segmented controls. */
export function hapticSelection(): void {
  if (!isSupported) return;
  Haptics.selectionAsync().catch(() => {});
}

import { Alert, Platform } from 'react-native';

/**
 * TASK-469: the only two messages about a wipe, in one place so the lock screen,
 * the recovery screen and the boot-time finish say the same thing.
 *
 * The "deleted" notice must be shown ONLY after wipeWalletData() has resolved
 * (its completeness check passed). Never on an error or timeout path.
 */
export const WIPE_COMPLETE_NOTICE = {
  title: 'Everything is deleted',
  body: 'All wallet data has been erased from this phone. You can now set up a new wallet.',
} as const;

export const WIPE_INCOMPLETE_NOTICE = {
  title: "Delete Everything didn't finish",
  body: "Some of your wallet data may still be on this phone. Restart the app and run Delete Everything again. Don't give this phone to anyone until it says everything is deleted.",
} as const;

function show(notice: { title: string; body: string }): void {
  if (Platform.OS === 'web') {
    window.alert(`${notice.title}\n\n${notice.body}`);
  } else {
    Alert.alert(notice.title, notice.body, [{ text: 'OK' }]);
  }
}

export function showWipeCompleteNotice(): void {
  show(WIPE_COMPLETE_NOTICE);
}

export function showWipeIncompleteNotice(): void {
  show(WIPE_INCOMPLETE_NOTICE);
}

import { AppState } from 'react-native';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { clearSessionSecurity } from '@/services/secure/sessionTeardown';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';

// One sitting spans queued dApps, but never unlocks AuthContext / Main.
export const REVIEW_IDLE_MS = 60_000;
let grant: { key: string; epoch: number; used: Set<string> } | null = null;
let generation = 0;
let expiresAt = 0;
let appStateSubscription:
  ReturnType<typeof AppState.addEventListener> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let authenticating = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const reviewGrant = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  isValid(key: string): boolean {
    return (
      !!grant &&
      grant.key === key &&
      grant.epoch === SessionKeyVault.currentEpoch() &&
      SessionKeyVault.isUnlocked() &&
      !AppLockSignal.isUnlocked() &&
      Date.now() < expiresAt
    );
  },
  touch(): void {
    if (!grant) return;
    if (!this.isValid(grant.key)) {
      this.revoke();
      return;
    }
    expiresAt = Date.now() + REVIEW_IDLE_MS;
    clearTimeout(timer);
    timer = setTimeout(() => this.revoke(), REVIEW_IDLE_MS);
  },
  revoke(clearKeys = true): void {
    generation++;
    const owned = grant !== null || authenticating;
    grant = null;
    appStateSubscription?.remove();
    appStateSubscription = undefined;
    clearTimeout(timer);
    // Never clear a session that the user has since unlocked normally.
    if (clearKeys && owned && !AppLockSignal.isUnlocked())
      clearSessionSecurity();
    emit();
  },
  async unlock(
    key: string,
    credential: { pin: string } | { biometric: true }
  ): Promise<boolean> {
    if (authenticating || AppLockSignal.isUnlocked()) return false;
    appStateSubscription ??= AppState.addEventListener('change', (state) => {
      if (state === 'background') this.revoke();
    });
    authenticating = true;
    const started = generation;
    const epoch = SessionKeyVault.currentEpoch();
    try {
      if ('pin' in credential) {
        const valid = await AccountSecureStorage.verifyPin(credential.pin);
        // verifyPin enforces the persisted, shared wallet throttle.
        if (!valid) return false;
        const source =
          (await AccountSecureStorage.getCredentialSource()) ?? 'pin';
        if (started !== generation || epoch !== SessionKeyVault.currentEpoch())
          return false;
        SessionKeyVault.set(credential.pin, source);
      } else {
        const result = await unlockVaultWithBiometrics(
          'Unlock to review WalletConnect requests'
        );
        if (result.status !== 'unlocked') return false;
      }
      if (
        started !== generation ||
        SessionKeyVault.currentEpoch() !== epoch + 1 ||
        AppState.currentState === 'background' ||
        AppLockSignal.isUnlocked()
      ) {
        if (!AppLockSignal.isUnlocked()) clearSessionSecurity();
        return false;
      }
      grant = { key, epoch: SessionKeyVault.currentEpoch(), used: new Set() };
      expiresAt = Date.now() + REVIEW_IDLE_MS;
      this.touch();
      emit();
      return true;
    } finally {
      authenticating = false;
    }
  },
  consume(key: string): boolean {
    if (!this.isValid(key) || grant!.used.has(key)) return false;
    grant!.used.add(key);
    this.touch();
    return true;
  },
  continueTo(key: string): void {
    if (grant && this.isValid(grant.key)) {
      grant.key = key;
      emit();
    }
  },
  leave(key: string): void {
    if (!grant || grant.key === key) this.revoke();
  },
};

// Re-locks and credential rotations invalidate a sitting synchronously.
SessionKeyVault.subscribe(() => {
  if (grant && grant.epoch !== SessionKeyVault.currentEpoch())
    reviewGrant.revoke(false);
});

export function walletConnectRequestKey(
  topic: string,
  id: string | number
): string {
  return JSON.stringify([topic, String(id)]);
}

// A re-lock invalidates review before the vault teardown, including a wallet
// that was already locked while a review grant was active.
AppLockSignal.subscribe(() => {
  reviewGrant.revoke(!AppLockSignal.isUnlocked());
});

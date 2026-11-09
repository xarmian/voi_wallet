import { AppState } from 'react-native';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { clearSessionSecurity } from '@/services/secure/sessionTeardown';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';

// A normal unlock mints one permission per request waiting at that moment.
// A gate unlock covers only its own request; later requests join no sitting.
export const REVIEW_IDLE_MS = 60_000;
let grant: {
  keys: Set<string>;
  epoch: number;
  lockedSitting: boolean;
  used: Set<string>;
  bindings: Map<string, string>;
  expiresAt: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  paused: Set<string>;
} | null = null;
export type ReviewEndReason =
  'idle' | 'lock' | 'background' | 'rotation' | 'left';
const endReasons = new Map<string, ReviewEndReason>();
let generation = 0;
let appStateSubscription:
  ReturnType<typeof AppState.addEventListener> | undefined;
let authenticating = false;
let authenticatingKey: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function createCapability(keys: string[], lockedSitting: boolean): void {
  endReasons.clear();
  grant = {
    keys: new Set(keys),
    epoch: SessionKeyVault.currentEpoch(),
    lockedSitting,
    used: new Set(),
    bindings: new Map(),
    expiresAt: new Map(keys.map((key) => [key, Date.now() + REVIEW_IDLE_MS])),
    timers: new Map(),
    paused: new Set(),
  };
  appStateSubscription ??= AppState.addEventListener('change', (state) => {
    if (state === 'background') reviewGrant.revoke(true, 'background');
  });
  keys.forEach((key) => armIdle(key));
  emit();
}

function armIdle(key: string): void {
  if (!grant) return;
  clearTimeout(grant.timers.get(key));
  grant.expiresAt.set(key, Date.now() + REVIEW_IDLE_MS);
  grant.timers.set(
    key,
    setTimeout(() => sweep(), REVIEW_IDLE_MS)
  );
}

function endKey(key: string, reason: ReviewEndReason): void {
  if (!grant?.keys.has(key)) return;
  endReasons.set(key, reason);
  clearTimeout(grant.timers.get(key));
  grant.timers.delete(key);
  grant.expiresAt.delete(key);
  grant.paused.delete(key);
  grant.keys.delete(key);
  grant.used.delete(key);
  grant.bindings.delete(key);
  if (grant.keys.size === 0) reviewGrant.revoke(true, reason);
  else emit();
}

function liveVault(): boolean {
  return (
    grant !== null &&
    grant.epoch === SessionKeyVault.currentEpoch() &&
    SessionKeyVault.isUnlocked() &&
    AppState.currentState !== 'background'
  );
}
function liveKey(key: string): boolean {
  return (
    !!grant?.keys.has(key) &&
    (grant.paused.has(key) || Date.now() < grant.expiresAt.get(key)!)
  );
}
/** Reconcile outside snapshot reads; lock and rotation also reconcile synchronously. */
function sweep(): void {
  if (!grant) return;
  if (
    grant.epoch !== SessionKeyVault.currentEpoch() ||
    !SessionKeyVault.isUnlocked()
  ) {
    reviewGrant.revoke(false, 'rotation');
    return;
  }
  if (AppState.currentState === 'background') {
    reviewGrant.revoke(true, 'background');
    return;
  }
  for (const key of [...grant.keys]) {
    if (!liveKey(key)) endKey(key, 'idle');
  }
}

export const reviewGrant = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Snapshot reads never reconcile expiry or emit during render. */
  isValid(key: string): boolean {
    return liveVault() && liveKey(key);
  },
  isUnspent(key: string): boolean {
    return this.isValid(key) && !grant!.used.has(key);
  },
  isLockedSitting(key: string): boolean {
    return this.isValid(key) && grant!.lockedSitting;
  },
  endReason(key: string): ReviewEndReason | null {
    return endReasons.get(key) ?? null;
  },
  mintForWaiting(keys: string[]): void {
    this.revoke(false);
    if (
      keys.length === 0 ||
      !AppLockSignal.isUnlocked() ||
      !SessionKeyVault.isUnlocked() ||
      AppState.currentState === 'background'
    )
      return;
    createCapability(keys, false);
  },
  touch(key: string): void {
    sweep();
    if (!this.isValid(key) || grant!.paused.has(key)) return;
    armIdle(key);
  },
  pauseIdle(key: string): boolean {
    sweep();
    if (!this.isValid(key) || !grant!.used.has(key)) return false;
    grant!.paused.add(key);
    clearTimeout(grant!.timers.get(key));
    grant!.timers.delete(key);
    return true;
  },
  revoke(clearKeys = true, reason: ReviewEndReason = 'left'): void {
    generation++;
    const owned = grant !== null || authenticating;
    grant?.keys.forEach((key) => endReasons.set(key, reason));
    grant?.timers.forEach((timer) => clearTimeout(timer));
    grant = null;
    appStateSubscription?.remove();
    appStateSubscription = undefined;
    // Never clear a session that the user has since unlocked normally.
    if (clearKeys && owned && !AppLockSignal.isUnlocked())
      clearSessionSecurity();
    emit();
  },
  async unlock(
    key: string,
    credential: { pin: string } | { biometric: true }
  ): Promise<boolean> {
    // Only a request included by the previous authentication may reuse it.
    if (this.isValid(key)) return true;
    if (authenticating) return false;
    // Fresh authentication replaces the old request set, even if it fails.
    this.revoke();
    const lockedSitting = !AppLockSignal.isUnlocked();
    appStateSubscription ??= AppState.addEventListener('change', (state) => {
      if (state === 'background') this.revoke(true, 'background');
    });
    authenticating = true;
    authenticatingKey = key;
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
        AppLockSignal.isUnlocked() === lockedSitting
      ) {
        if (!AppLockSignal.isUnlocked()) clearSessionSecurity();
        return false;
      }
      createCapability([key], lockedSitting);
      return true;
    } finally {
      authenticating = false;
      authenticatingKey = null;
    }
  },
  bind(key: string, digest: string): boolean {
    sweep();
    if (!this.isValid(key)) return false;
    const previous = grant!.bindings.get(key);
    if (previous !== undefined && previous !== digest) {
      this.leave(key);
      return false;
    }
    grant!.bindings.set(key, digest);
    return true;
  },
  consume(key: string, digest: string): boolean {
    sweep();
    if (
      !this.isValid(key) ||
      grant!.used.has(key) ||
      !grant!.bindings.has(key) ||
      grant!.bindings.get(key) !== digest
    )
      return false;
    grant!.used.add(key);
    this.touch(key);
    emit();
    return true;
  },
  isConsumedFor(key: string, digest: string): boolean {
    return (
      this.isValid(key) &&
      grant!.used.has(key) &&
      grant!.bindings.has(key) &&
      grant!.bindings.get(key) === digest
    );
  },
  /** Keep a locked sitting alive only while its screen publishes the outcome. */
  settle(key: string): void {
    sweep();
    if (!this.isValid(key)) return;
    if (!grant!.lockedSitting) {
      this.leave(key);
      return;
    }
    // Settlement never returns a spent permission to the unspent pool.
    grant!.used.add(key);
    grant!.paused.delete(key);
    armIdle(key);
  },
  /**
   * A request's screen left. Ends the sitting only when it was the last
   * request in it, or when it aborts that request's own in-flight unlock;
   * a screen with no part in the sitting changes nothing.
   */
  leave(key: string): void {
    if (authenticating && authenticatingKey === key) {
      this.revoke();
      return;
    }
    endKey(key, 'left');
  },
};

// Re-locks and credential rotations invalidate a sitting synchronously.
SessionKeyVault.subscribe(() => {
  if (grant && grant.epoch !== SessionKeyVault.currentEpoch())
    reviewGrant.revoke(false, 'rotation');
});

export function walletConnectRequestKey(
  topic: string,
  id: string | number
): string {
  return JSON.stringify([topic, String(id)]);
}

/** Shared request-key scheme for the router and proposal screen. */
export function walletConnectProposalKey(
  pairingTopic: string,
  id: string | number
): string {
  return walletConnectRequestKey(pairingTopic, `proposal-${id}`);
}

/**
 * A v1 connect request is keyed by its peer id, not its request id. The v1
 * payload carries no peer id, so every v1 key is `proposal-`; that is safe
 * because only one v1 proposal can be open at a time.
 */
export function walletConnectV1ProposalKey(
  peerId: string | number | undefined
): string {
  return walletConnectRequestKey('v1', `proposal-${peerId ?? ''}`);
}

// A re-lock invalidates review before the vault teardown, including a wallet
// that was already locked while a review grant was active.
AppLockSignal.subscribe(() => {
  // AuthContext sets unlocked BEFORE minting the waiting-request capability.
  // Its repeated unlocked notifications must only end an older gate sitting.
  if (!AppLockSignal.isUnlocked()) reviewGrant.revoke(true, 'lock');
  else if (grant?.lockedSitting) reviewGrant.revoke(false, 'lock');
});

/**
 * Covers the network id, each entry's txn bytes in order, and the reviewed
 * signer addresses sorted. This checks consistency between review and signing;
 * it is not a digest of the whole ARC-0001 entry. Length-prefixed fields and
 * list counts preserve transaction boundaries.
 */
export function reviewBindingDigest(input: {
  networkId: string;
  txnBytesBase64: string[];
  signerAddresses: string[];
}): string {
  const field = (value: string) => `${value.length}:${value}`;
  const list = (values: string[]) =>
    `${values.length}:${values.map(field).join('')}`;
  return bytesToHex(
    sha256(
      utf8ToBytes(
        field(input.networkId) +
          list(input.txnBytesBase64) +
          list([...input.signerAddresses].sort())
      )
    )
  );
}

/** No ambient-network fallback is allowed for a scoped signing permission. */
export function walletConnectReviewDigest(args: {
  requestNetworkId?: string | null;
  sessionBindingNetworkId?: string | null;
  transactions: { txn: string }[];
  reviewedSigners: string[];
}): string | null {
  const networkId = args.sessionBindingNetworkId ?? args.requestNetworkId;
  if (
    !networkId ||
    (args.requestNetworkId && args.requestNetworkId !== networkId)
  )
    return null;
  return reviewBindingDigest({
    networkId,
    txnBytesBase64: args.transactions.map((transaction) => transaction.txn),
    signerAddresses: args.reviewedSigners,
  });
}

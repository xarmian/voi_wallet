import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  classifyKeyHolding,
  isBackupVerified,
  KeyHolding,
  needsBackupVerification,
} from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { useWalletStore } from './walletStore';
import { useNetworkRekeyStatus } from './useNetworkRekeyStatus';

/** Active-account-only work after paint; unrelated wallet changes retain identity. */
export function useHomeBackupReminder(): boolean {
  const account = useWalletStore(
    useShallow((state) => {
      const active = state.wallet?.accounts.find(
        (item) => item.id === state.wallet?.activeAccountId
      );
      return active
        ? {
            id: active.id,
            address: active.address,
            type: active.type,
            originalOwner:
              'originalOwner' in active ? active.originalOwner : undefined,
            backupVerified:
              'backupVerified' in active ? active.backupVerified : undefined,
          }
        : null;
    })
  );
  // Only an unverified account that may hold its key can remind, so only it
  // pays for a secret probe or per-network lookups (U4e review Low).
  const candidate =
    account &&
    !isBackupVerified(account) &&
    classifyKeyHolding(account) !== 'absent'
      ? account
      : null;
  const { delegatedEverywhere } = useNetworkRekeyStatus(
    candidate?.address ?? ''
  );
  const [probe, setProbe] = useState<{
    account: typeof account;
    holding: KeyHolding;
  } | null>(null);
  useEffect(() => {
    if (!candidate || classifyKeyHolding(candidate) !== 'unresolved') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        void AccountSecureStorage.probeSecretPresenceStrict(candidate.id)
          .then((present) => {
            if (live)
              setProbe({
                account: candidate,
                holding: present ? 'present' : 'absent',
              });
          })
          .catch(() => {
            if (live) setProbe({ account: candidate, holding: 'unresolved' });
          });
      }, 0);
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [candidate]);
  // Check identity during render too: effects haven't cleaned up yet on a switch.
  const holding = classifyKeyHolding(
    account,
    probe?.account === account ? probe.holding : 'unresolved'
  );
  return needsBackupVerification(account, holding, delegatedEverywhere);
}

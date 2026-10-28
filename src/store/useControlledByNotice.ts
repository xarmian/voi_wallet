import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  AccountType,
  classifyKeyHolding,
  isBackupVerified,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { useWalletStore } from './walletStore';
import { useNetworkRekeyStatus } from './useNetworkRekeyStatus';

export function useControlledByNotice() {
  const active = useWalletStore(
    useShallow((state) => {
      const account = state.wallet?.accounts.find(
        (a) => a.id === state.wallet?.activeAccountId
      );
      return account ? { id: account.id, address: account.address } : null;
    })
  );
  const { perNetwork } = useNetworkRekeyStatus(active?.address ?? '');
  const delegated = useMemo(() => {
    const groups = new Map<string, NetworkId[]>();
    for (const [network, status] of Object.entries(perNetwork)) {
      if (status.status !== 'delegated') continue;
      groups.set(status.authAddress, [
        ...(groups.get(status.authAddress) ?? []),
        network as NetworkId,
      ]);
    }
    return [...groups].map(([address, networks]) => ({ address, networks }));
  }, [perNetwork]);
  // Flat primitive projection lets useShallow ignore unrelated wallet changes.
  // Only strict delegated addresses are selected; never traverse their signers.
  const fields = useWalletStore(
    useShallow((state) =>
      delegated.flatMap(({ address }) => {
        const a = state.wallet?.accounts.find(
          (item) => item.address === address
        );
        return a
          ? [
              a.id,
              a.address,
              a.type,
              'originalOwner' in a ? a.originalOwner : undefined,
              'backupVerified' in a ? a.backupVerified : undefined,
            ]
          : [];
      })
    )
  );
  const candidates = useMemo(() => {
    const accounts = [];
    for (let i = 0; i < fields.length; i += 5) {
      const account = {
        id: fields[i] as string,
        address: fields[i + 1] as string,
        type: fields[i + 2] as AccountType,
        originalOwner: fields[i + 3] as boolean | undefined,
        backupVerified: fields[i + 4] as boolean | undefined,
      };
      if (
        !isBackupVerified(account) &&
        classifyKeyHolding(account) !== 'absent'
      )
        accounts.push(account);
    }
    return accounts;
  }, [fields]);
  const [probe, setProbe] = useState<{
    active: typeof active;
    candidates: typeof candidates;
    present: string[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        for (const account of candidates) {
          if (classifyKeyHolding(account) !== 'unresolved') continue;
          void AccountSecureStorage.probeSecretPresenceStrict(account.id)
            .catch(() => false)
            .then((present) => {
              if (live && present)
                setProbe((previous) => ({
                  active,
                  candidates,
                  present: [
                    ...(previous?.active === active &&
                    previous.candidates === candidates
                      ? previous.present
                      : []),
                    account.address,
                  ],
                }));
            });
        }
      }, 0);
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [active, candidates]);
  return delegated
    .filter(({ address }) => {
      const account = candidates.find((a) => a.address === address);
      return (
        classifyKeyHolding(
          account,
          probe?.active === active &&
            probe?.candidates === candidates &&
            probe.present.includes(address)
            ? 'present'
            : 'unresolved'
        ) === 'present'
      );
    })
    .map((notice) => ({
      ...notice,
      showNetworks:
        new Set(
          Object.values(perNetwork).map((s) =>
            s.status === 'delegated' ? s.authAddress : s.status
          )
        ).size > 1,
    }));
}

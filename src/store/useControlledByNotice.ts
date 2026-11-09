import { useEffect, useMemo, useRef, useState } from 'react';
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

const probeKey = (account: {
  id: string;
  address: string;
  type: AccountType;
}) => `${account.id}:${account.address}:${account.type}`;

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
  // Probe results live for the active account, keyed by each controller's
  // identity and custody type, so a status-cache expiry that briefly drops a
  // controller doesn't cancel or repeat its secure read (U4f review Low).
  // Switching the active account discards them.
  const [probed, setProbed] = useState<{
    active: typeof active;
    present: ReadonlySet<string>;
  } | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    const gen = generation;
    gen.current++;
    inFlight.current = new Set();
    // Retire this active account's probes on a switch or unmount.
    return () => {
      gen.current++;
    };
  }, [active]);
  useEffect(() => {
    const current = generation.current;
    // This generation's markers: a late rejection from an earlier active
    // account must never clear a marker for the current one.
    const flights = inFlight.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        for (const account of candidates) {
          if (classifyKeyHolding(account) !== 'unresolved') continue;
          const key = probeKey(account);
          if (flights.has(key)) continue;
          flights.add(key);
          void AccountSecureStorage.probeSecretPresenceStrict(account.id)
            // A failed read may be retried on a later candidate change.
            .catch(() => {
              flights.delete(key);
              return false;
            })
            .then((present) => {
              if (generation.current !== current || !present) return;
              setProbed((previous) => ({
                active,
                present: new Set([
                  ...(previous?.active === active ? previous.present : []),
                  key,
                ]),
              }));
            });
        }
      }, 0);
    });
    return () => {
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
          account &&
            probed?.active === active &&
            probed.present.has(probeKey(account))
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

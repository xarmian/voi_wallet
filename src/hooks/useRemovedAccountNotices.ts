import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';

export type RemovedAccountRecord = {
  id: string;
  address: string;
  label: string;
};

export function useRemovedAccountNotices() {
  const [notices, setNotices] = useState<RemovedAccountRecord[]>([]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void (async () => {
        let records: RemovedAccountRecord[];
        try {
          records = await AccountSecureStorage.readUnexplainedRemovals();
        } catch {
          console.warn('Unable to read removed account notices');
          if (active) setNotices([]);
          return;
        }
        if (!active) return;
        if (records.length === 0) {
          setNotices([]);
          return;
        }

        let addresses: Set<string>;
        try {
          const accounts = await MultiAccountWalletService.getAllAccounts();
          // A watch-only account for the address does not bring the key back,
          // so it must not clear the card; every signing type does.
          addresses = new Set(
            accounts
              .filter((account) => account.type !== AccountType.WATCH)
              .map((account) => account.address)
          );
        } catch {
          if (active) setNotices(records);
          return;
        }
        if (!active) return;

        const restored = records.filter((record) =>
          addresses.has(record.address)
        );
        const remaining = records.filter(
          (record) => !addresses.has(record.address)
        );
        if (restored.length) {
          await Promise.all(
            restored.map(async ({ id }) => {
              try {
                await AccountSecureStorage.clearUnexplainedRemoval(id);
              } catch {
                console.warn('Unable to clear removed account notice', id);
              }
            })
          );
        }
        if (active) setNotices(remaining);
      })();
      return () => {
        active = false;
      };
    }, [])
  );

  const dismiss = useCallback(async (id: string): Promise<void> => {
    setNotices((current) => current.filter((record) => record.id !== id));
    try {
      await AccountSecureStorage.clearUnexplainedRemoval(id);
    } catch {
      console.warn('Unable to clear removed account notice', id);
    }
  }, []);

  return { notices: notices.slice(0, 1), dismiss };
}

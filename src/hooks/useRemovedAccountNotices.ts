import { useCallback, useEffect, useState } from 'react';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

export type RemovedAccountRecord = {
  id: string;
  address: string;
  label: string;
};

export function useRemovedAccountNotices() {
  const [notices, setNotices] = useState<RemovedAccountRecord[]>([]);

  useEffect(() => {
    let mounted = true;
    void AccountSecureStorage.readUnexplainedRemovals()
      .then((records) => {
        if (mounted) setNotices(records);
      })
      .catch(() => {
        console.warn('Unable to read removed account notices');
        if (mounted) setNotices([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  /**
   * Hides the notice immediately, then resolves once its stored record is
   * cleared (a clear failure is logged by id and swallowed). Callers that
   * navigate away await this so a slow write cannot bring the notice back.
   */
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

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

  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((record) => record.id !== id));
    void AccountSecureStorage.clearUnexplainedRemoval(id).catch(() => {
      console.warn('Unable to clear removed account notice', id);
    });
  }, []);

  return { notices: notices.slice(0, 1), dismiss };
}

import React, { useCallback, useEffect, useRef } from 'react';
import RemovedAccountNotice from './RemovedAccountNotice';
import { useRemovedAccountNotices } from '@/hooks/useRemovedAccountNotices';

export default function RemovedAccountNoticeHost({
  onReimport,
}: {
  onReimport: () => void;
}) {
  const { notices, dismiss } = useRemovedAccountNotices();
  const notice = notices[0];
  // One action at a time: a second tap while the record is still being cleared
  // must not stack a duplicate import screen or a concurrent clear.
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleReimport = useCallback(async () => {
    if (!notice || busyRef.current) return;
    busyRef.current = true;
    try {
      await dismiss(notice.id);
      // The user may have left Home while the clear was pending; never open
      // the import screen over wherever they went.
      if (mountedRef.current) onReimport();
    } finally {
      busyRef.current = false;
    }
  }, [dismiss, notice, onReimport]);

  const handleDismiss = useCallback(async () => {
    if (!notice || busyRef.current) return;
    busyRef.current = true;
    try {
      await dismiss(notice.id);
    } finally {
      busyRef.current = false;
    }
  }, [dismiss, notice]);

  if (!notice) return null;
  return (
    <RemovedAccountNotice
      label={notice.label}
      address={notice.address}
      onReimport={() => {
        void handleReimport();
      }}
      onDismiss={() => {
        void handleDismiss();
      }}
    />
  );
}

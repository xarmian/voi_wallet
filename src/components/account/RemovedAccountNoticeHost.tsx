import React, { useCallback } from 'react';
import RemovedAccountNotice from './RemovedAccountNotice';
import { useRemovedAccountNotices } from '@/hooks/useRemovedAccountNotices';

export default function RemovedAccountNoticeHost({
  onReimport,
}: {
  onReimport: () => void;
}) {
  const { notices, dismiss } = useRemovedAccountNotices();
  const notice = notices[0];
  const handleReimport = useCallback(async () => {
    if (!notice) return;
    await dismiss(notice.id);
    onReimport();
  }, [dismiss, notice, onReimport]);

  if (!notice) return null;
  return (
    <RemovedAccountNotice
      label={notice.label}
      address={notice.address}
      onReimport={() => {
        void handleReimport();
      }}
      onDismiss={() => {
        void dismiss(notice.id);
      }}
    />
  );
}

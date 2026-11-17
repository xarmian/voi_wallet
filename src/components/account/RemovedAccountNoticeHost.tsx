import React from 'react';
import RemovedAccountNotice from './RemovedAccountNotice';
import { useRemovedAccountNotices } from '@/hooks/useRemovedAccountNotices';

export default function RemovedAccountNoticeHost({
  onReimport,
}: {
  onReimport: () => void;
}) {
  const { notices, dismiss } = useRemovedAccountNotices();
  const notice = notices[0];
  if (!notice) return null;

  return (
    <RemovedAccountNotice
      label={notice.label}
      address={notice.address}
      onReimport={onReimport}
      onDismiss={() => {
        void dismiss(notice.id);
      }}
    />
  );
}

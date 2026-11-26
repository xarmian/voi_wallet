import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import KeysNotInBackupModal from '../KeysNotInBackupModal';
import { buildBackupReport } from '@/services/backup/backupReport';
import type { BackupLeftOutReason } from '@/services/backup/types';
let mockRequestClose: () => void;
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return Object.defineProperty(Object.create(actual), 'Modal', {
    value: (props: React.ComponentProps<typeof actual.Modal>) => {
      mockRequestClose = props.onRequestClose;
      return <actual.Modal {...props} />;
    },
  });
});
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));

it.each<BackupLeftOutReason[]>([
  ['no-key-on-device'],
  ['key-unreadable', 'no-key-on-device'],
  ['other-key-on-device'],
  ['other-key-on-device', 'other-key-on-device'],
  ['key-unreadable', 'other-key-on-device'],
])('renders report blocks for %j', async (...reasons) => {
  const report = buildBackupReport({
    incomplete: {
      leftOut: reasons.map((reason, i) => ({
        reason,
        address: String(i).repeat(58),
        label: `Account ${i}`,
      })),
    },
  });
  const onAcknowledge = jest.fn();
  const view = await render(
    <KeysNotInBackupModal
      visible
      report={report}
      onAcknowledge={onAcknowledge}
    />
  );
  expect(view.getByText(report.title!)).toBeTruthy();
  for (const block of [report.withoutKey, report.otherKey]) {
    if (!block) continue;
    expect(view.getByText(block.text)).toBeTruthy();
    for (const row of block.rows) {
      expect(view.getByText(`${row.label} (${row.shortAddress})`)).toBeTruthy();
      expect(view.getAllByText(row.reason).length).toBeGreaterThan(0);
    }
    if (block.advice) expect(view.getByText(block.advice)).toBeTruthy();
  }
  mockRequestClose();
  expect(onAcknowledge).not.toHaveBeenCalled();
  await fireEvent.press(
    view.getByRole('button', { name: report.acknowledgeText })
  );
  expect(onAcknowledge).toHaveBeenCalledTimes(1);
});
it('renders nothing for a complete report', async () => {
  const view = await render(
    <KeysNotInBackupModal
      visible
      report={buildBackupReport({})}
      onAcknowledge={jest.fn()}
    />
  );
  expect(view.toJSON()).toBeNull();
});

// TASK-504: the confirmation says restore only adds. "Replace ALL" is gone, the
// settings line shows only on a wallet with accounts, and friends are not
// listed as restored where they are not taken.

import React from 'react';
import { render } from '@testing-library/react-native';
import RestoreConfirmationModal from '../RestoreConfirmationModal';
import {
  RESTORE_ADDS_TEXT,
  SETTINGS_STAY_TEXT,
} from '@/services/backup/restoreReport';
import type { BackupInfo } from '@/services/backup';

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const info = {
  createdAt: '2026-11-05T00:00:00Z',
  appVersion: '0.2.0',
  accountCount: 2,
  accountTypes: { standard: 2, watch: 0, rekeyed: 0, ledger: 0 },
  hasFriends: true,
  friendsCount: 3,
} as unknown as BackupInfo;

async function show(deviceHasAccounts: boolean) {
  return render(
    <RestoreConfirmationModal
      visible
      backupInfo={info}
      deviceHasAccounts={deviceHasAccounts}
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  );
}

describe('RestoreConfirmationModal', () => {
  it('a device with no accounts: says restore adds, with no settings line, and lists friends', async () => {
    const view = await show(false);
    expect(view.getByText(RESTORE_ADDS_TEXT)).toBeTruthy();
    expect(view.queryByText(/replace ALL/i)).toBeNull();
    expect(view.queryByText(/settings stay/i)).toBeNull();
    expect(view.getByText('Friends')).toBeTruthy();
  });

  it('a device with accounts: adds the settings line and does not list friends as restored', async () => {
    const view = await show(true);
    expect(
      view.getByText(`${RESTORE_ADDS_TEXT} ${SETTINGS_STAY_TEXT}`)
    ).toBeTruthy();
    expect(view.queryByText(/replace ALL/i)).toBeNull();
    expect(view.queryByText('Friends')).toBeNull();
  });
});

// The expected text is written out here, not computed by the function under
// test: the wording is product's (e7912207 item 5) and the modal must show it.
it.each([
  [
    1,
    "This backup doesn't have the key for 1 account. It'll be added without it.",
  ],
  [
    3,
    "This backup doesn't have the keys for 3 accounts. They'll be added without them.",
  ],
  [0, null],
])(
  'shows the missing-own-key line for %s accounts',
  async (count, expected) => {
    const incomplete = {
      leftOut: [
        ...Array.from({ length: count }, (_, i) => ({
          address: String(i).repeat(58),
          reason: 'no-key-on-device' as const,
        })),
        // An account whose own key IS in the file never counts here.
        { address: 'Z'.repeat(58), reason: 'other-key-on-device' as const },
      ],
    };
    const view = await render(
      <RestoreConfirmationModal
        visible
        backupInfo={{ ...info, incomplete }}
        deviceHasAccounts={false}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />
    );
    if (expected) expect(view.getByText(expected)).toBeTruthy();
    else expect(view.queryByText(/This backup doesn't have/)).toBeNull();
  }
);

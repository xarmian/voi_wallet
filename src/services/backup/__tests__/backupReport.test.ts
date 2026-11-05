import {
  buildBackupReport,
  LEFT_OUT_REASON_TEXT,
  KEY_UNREADABLE_ADVICE,
} from '../backupReport';

const addr = (c: string) => c.repeat(58);

describe('TASK-504: backup report copy', () => {
  it('a complete backup has no report', () => {
    expect(buildBackupReport({ totalAccountCount: 3 })).toEqual({
      incomplete: false,
      rows: [],
    });
    expect(
      buildBackupReport({ totalAccountCount: 3, incomplete: { leftOut: [] } })
    ).toEqual({ incomplete: false, rows: [] });
  });

  it('pins the title, summary, reasons and advice verbatim', () => {
    const report = buildBackupReport({
      totalAccountCount: 12,
      incomplete: {
        leftOut: [
          { address: addr('A'), label: 'One', reason: 'no-key-on-device' },
          { address: addr('B'), reason: 'key-unreadable' },
        ],
      },
    });
    expect(report.incomplete).toBe(true);
    expect(report.title).toBe('Backup incomplete');
    expect(report.summary).toBe(
      "Saved 10 of 12 accounts. These weren't included:"
    );
    expect(report.rows.map((r) => [r.label, r.reason])).toEqual([
      ['One', 'No key on this device'],
      ['Account', "Couldn't read this key"],
    ]);
    // The address is required on every row.
    expect(report.rows.every((r) => r.shortAddress.length > 0)).toBe(true);
    expect(LEFT_OUT_REASON_TEXT).toEqual({
      'no-key-on-device': 'No key on this device',
      'key-unreadable': "Couldn't read this key",
      'other-key-on-device':
        "Its own key is in this backup. A different key stored with it isn't.",
    });
    expect(report.advice).toBe(
      'Keep this wallet installed until these accounts are safe. Open each one and try to view its recovery phrase. If it opens, write it down.'
    );
    expect(KEY_UNREADABLE_ADVICE).toBe(report.advice);
  });

  it('the advice appears only when a key could not be read', () => {
    const report = buildBackupReport({
      totalAccountCount: 2,
      incomplete: {
        leftOut: [
          { address: addr('A'), label: 'One', reason: 'no-key-on-device' },
        ],
      },
    });
    expect(report.advice).toBeUndefined();
  });
});

// TASK-504: the words a restore ends with. Titles, rows and the two closing
// lines are product's (DOC-507 3.6 item 5 and 5.3); the tests pin them.

import algosdk from 'algosdk';
import {
  buildRestoreReport,
  formatRestoreReport,
  NOT_FRESH_LINE,
  OUTCOME_TEXT,
  PAIRINGS_LINE,
} from '../restoreReport';
import type {
  RestoreRecordOutcome,
  RestoreRecordResult,
  RestoreResult,
} from '../types';

const address = () => algosdk.generateAccount().addr.toString();

function rec(
  outcome: RestoreRecordOutcome,
  label = 'Acct'
): RestoreRecordResult {
  return { id: `id-${label}`, address: address(), label, outcome };
}

function result(
  records: RestoreRecordResult[],
  extra: Partial<RestoreResult> = {}
): RestoreResult {
  return {
    records,
    accountCount: 0,
    ledgerAccountCount: 0,
    standardAccountCount: 0,
    watchAccountCount: 0,
    rekeyedAccountCount: 0,
    remoteSignerAccountCount: 0,
    duplicateAccountsDropped: 0,
    settingsRestored: true,
    friendsCount: 0,
    remoteSignerSettingsRestored: false,
    pairedSignersNotRestored: 0,
    ...extra,
  };
}

describe('restore report titles', () => {
  it('every record added: "Restore complete"', () => {
    const r = buildRestoreReport(result([rec('added'), rec('added', 'B')]));
    expect(r.title).toBe('Restore complete');
    expect(r.summary).toBe('Added 2 of 2 accounts.');
    expect(r.rows).toEqual([]);
  });

  it('nothing added and nothing wrong: "Nothing to add"', () => {
    const r = buildRestoreReport(
      result([rec('already-present'), rec('kept-device-record', 'B')])
    );
    expect(r.title).toBe('Nothing to add');
    expect(r.summary).toBe(
      'Every account in this backup is already on this device.'
    );
  });

  it.each<RestoreRecordOutcome>([
    'rejected-id-conflict',
    'rejected-slot-occupied',
    'rejected-no-safe-slot',
    'rejected-invalid',
  ])('anything rejected (%s) with nothing added: "Restore finished"', (o) => {
    const r = buildRestoreReport(result([rec(o)]));
    expect(r.title).toBe('Restore finished');
    expect(r.summary).toBe('Added 0 of 1 accounts. Check the list below.');
  });

  it('a mix of added and already-present is "Restore finished" with the count', () => {
    const r = buildRestoreReport(
      result([rec('added'), rec('already-present', 'B'), rec('added', 'C')])
    );
    expect(r.title).toBe('Restore finished');
    expect(r.summary).toBe('Added 2 of 3 accounts. Check the list below.');
  });
});

describe('restore report rows', () => {
  it('lists every record that was not simply added, with label, short address and its row text', () => {
    const rejected = rec('rejected-slot-occupied', 'Savings');
    const r = buildRestoreReport(result([rec('added'), rejected]));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].label).toBe('Savings');
    expect(r.rows[0].shortAddress).toBe(
      `${rejected.address.slice(0, 6)}...${rejected.address.slice(-4)}`
    );
    expect(r.rows[0].text).toBe(
      'Not added. A stored key is already in its place on this device.'
    );
  });

  it("uses product's row texts verbatim", () => {
    expect(OUTCOME_TEXT.added).toBe('Added');
    expect(OUTCOME_TEXT['added-new-id']).toBe(
      "Added. This phone was already storing something else in this account's place. We left that alone and added the account separately."
    );
    expect(OUTCOME_TEXT['already-present']).toBe('Already on this device');
    expect(OUTCOME_TEXT['kept-device-record']).toBe('Already on this device');
    expect(OUTCOME_TEXT['rejected-id-conflict']).toBe(
      'Not added. It conflicts with another account on this device.'
    );
    expect(OUTCOME_TEXT['rejected-slot-occupied']).toBe(
      'Not added. A stored key is already in its place on this device.'
    );
  });

  it('every outcome has a row text', () => {
    const outcomes: RestoreRecordOutcome[] = [
      'added',
      'added-new-id',
      'added-in-place',
      'already-present',
      'kept-device-record',
      'rejected-id-conflict',
      'rejected-slot-occupied',
      'rejected-no-safe-slot',
      'rejected-invalid',
    ];
    for (const o of outcomes) expect(OUTCOME_TEXT[o]).toBeTruthy();
  });
});

describe('restore report closing lines', () => {
  it('a fresh first run never shows the accounts-only line', () => {
    const r = buildRestoreReport(
      result([rec('added')], { settingsRestored: true })
    );
    expect(r.notes).not.toContain(NOT_FRESH_LINE);
    expect(formatRestoreReport(r)).not.toContain('Only accounts were restored');
  });

  it('a restore that is not fresh ends with the accounts-only line, after every other note', () => {
    const r = buildRestoreReport(
      result([rec('added')], {
        settingsRestored: false,
        ledgerAccountCount: 1,
        duplicateAccountsDropped: 2,
      })
    );
    expect(r.notes[r.notes.length - 1]).toBe(NOT_FRESH_LINE);
    expect(NOT_FRESH_LINE).toBe(
      "Only accounts were restored. This phone's settings and friends weren't changed."
    );
    expect(formatRestoreReport(r).endsWith(NOT_FRESH_LINE)).toBe(true);
  });

  it('the pairing line shows only when pairings were left out', () => {
    expect(
      buildRestoreReport(
        result([rec('added')], { pairedSignersNotRestored: 0 })
      ).notes
    ).not.toContain(PAIRINGS_LINE);
    expect(
      buildRestoreReport(
        result([rec('added')], { pairedSignersNotRestored: 2 })
      ).notes
    ).toContain(PAIRINGS_LINE);
    expect(PAIRINGS_LINE).toBe(
      "Airgap signer pairings in this backup weren't restored. To sign with one, pair it again."
    );
  });

  it('nothing in a not-fresh report claims settings or friends came across', () => {
    const text = formatRestoreReport(
      buildRestoreReport(
        result([rec('added'), rec('rejected-id-conflict', 'B')], {
          settingsRestored: false,
          friendsCount: 0,
        })
      )
    );
    expect(text).not.toMatch(
      /friend\(s\)|settings restored|restored settings/i
    );
  });
});

describe('TASK-504: an incomplete file adds "Not in this backup"', () => {
  const leftOut = [
    { address: address(), label: 'Gone', reason: 'key-unreadable' as const },
    { address: address(), reason: 'no-key-on-device' as const },
  ];

  it('names each left-out account with its address and reason', () => {
    const report = buildRestoreReport(
      result([rec('added')], { leftOut, settingsRestored: false })
    );
    expect(report.notInBackup?.title).toBe('Not in this backup');
    expect(report.notInBackup?.rows.map((r) => [r.label, r.text])).toEqual([
      ['Gone', "Couldn't read this key"],
      ['Account', 'No key on this device'],
    ]);
    expect(
      report.notInBackup?.rows.every((r) => r.shortAddress.length > 0)
    ).toBe(true);
  });

  it('the section comes before the closing line, which stays last', () => {
    const report = buildRestoreReport(
      result([rec('added')], { leftOut, settingsRestored: false })
    );
    const text = formatRestoreReport(report);
    expect(text).toContain('Not in this backup');
    expect(text.indexOf('Not in this backup')).toBeLessThan(
      text.indexOf(NOT_FRESH_LINE)
    );
    expect(text.endsWith(NOT_FRESH_LINE)).toBe(true);
  });

  it('a complete file has no such section', () => {
    const report = buildRestoreReport(result([rec('added')]));
    expect(report.notInBackup).toBeUndefined();
    expect(formatRestoreReport(report)).not.toContain('Not in this backup');
  });
});

// TASK-504: what the user is told after a backup. Product's copy, verbatim
// (e7912207 item 4, db99d45f, 2c7b0680): every line singular and plural, the k
// and j counts kept apart, and no word that says a key was lost or deleted.

import algosdk from 'algosdk';
import {
  ACKNOWLEDGE_BUTTON_TEXT,
  KEY_UNREADABLE_ADVICE,
  LEFT_OUT_REASON_TEXT,
  androidSavedAlertText,
  buildBackupReport,
  restoreConfirmationKeysLine,
} from '../backupReport';
import type { BackupLeftOutAccount } from '../types';

// Real addresses, so formatAddress shortens them as it does in the app.
const ADDRESSES = Array.from({ length: 5 }, () =>
  algosdk.generateAccount().addr.toString()
);
const A = (n: number) => ADDRESSES[n];

const none = (n: number): BackupLeftOutAccount => ({
  address: A(n),
  label: `none-${n}`,
  reason: 'no-key-on-device',
});
const bad = (n: number): BackupLeftOutAccount => ({
  address: A(n),
  label: `bad-${n}`,
  reason: 'key-unreadable',
});
const other = (n: number): BackupLeftOutAccount => ({
  address: A(n),
  label: `other-${n}`,
  reason: 'other-key-on-device',
});
const report = (...leftOut: BackupLeftOutAccount[]) =>
  buildBackupReport({ incomplete: { leftOut } });

describe('TASK-504: backup report copy', () => {
  it('a complete backup has no report: no title, no blocks, counts of zero', () => {
    const r = buildBackupReport({});
    expect(r.incomplete).toBe(false);
    expect(r.title).toBeUndefined();
    expect(r.withoutKey).toBeUndefined();
    expect(r.otherKey).toBeUndefined();
    expect([r.withoutKeyCount, r.otherKeyCount]).toEqual([0, 0]);
    expect(buildBackupReport({ incomplete: { leftOut: [] } }).incomplete).toBe(
      false
    );
  });

  it('pins the reason lines and the button verbatim', () => {
    expect(LEFT_OUT_REASON_TEXT).toEqual({
      'no-key-on-device': 'No key on this device',
      'key-unreadable': "Couldn't read this key",
      'other-key-on-device':
        "Its own key is in this backup. A different key stored with it isn't.",
    });
    expect(ACKNOWLEDGE_BUTTON_TEXT).toBe('I understand');
    expect(KEY_UNREADABLE_ADVICE).toBe(
      'Keep this wallet installed until these accounts are safe. Open each one and try to view its recovery phrase. If it opens, write it down.'
    );
  });

  it('one account without its key: the singular title and text', () => {
    const r = report(none(1));
    expect(r.incomplete).toBe(true);
    expect(r.title).toBe("A key isn't in this backup");
    expect(r.withoutKey?.text).toBe(
      "This backup doesn't have the key for this account. You'll still see it after a restore, but this backup can't give you that key."
    );
    expect(r.withoutKeyCount).toBe(1);
    expect(r.otherKey).toBeUndefined();
    expect(r.acknowledgeText).toBe('I understand');
  });

  it('several accounts without their keys: the plural title and text with k', () => {
    const r = report(none(1), bad(2), none(3));
    expect(r.title).toBe("Some keys aren't in this backup");
    expect(r.withoutKey?.text).toBe(
      "This backup doesn't have the keys for these 3 accounts. You'll still see them after a restore, but this backup can't give you those keys."
    );
    expect(r.withoutKeyCount).toBe(3);
  });

  it('every row names the account with a short address and its reason', () => {
    const r = report(none(1), bad(2));
    expect(r.withoutKey?.rows.map((x) => [x.label, x.reason])).toEqual([
      ['none-1', 'No key on this device'],
      ['bad-2', "Couldn't read this key"],
    ]);
    // Shortened, not the full address.
    expect(
      r.withoutKey?.rows.every(
        (x) => x.shortAddress.includes('...') && x.shortAddress.length < 20
      )
    ).toBe(true);
  });

  it('the keep-installed advice shows only when a key could not be read', () => {
    expect(report(none(1)).withoutKey?.advice).toBeUndefined();
    expect(report(none(1), bad(2)).withoutKey?.advice).toBe(
      KEY_UNREADABLE_ADVICE
    );
  });

  it('never claims a key was lost, deleted or gone (the keep-installed advice says "isn\'t lost", which is a promise, not a claim)', () => {
    const all = report(none(1), bad(2), other(3), other(4));
    // Everything the user reads except product's own advice line for the
    // other-key block.
    const { advice: _advice, ...otherNoAdvice } = all.otherKey!;
    void _advice;
    // The words the user reads: string VALUES only, not field names.
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk({ ...all, otherKey: otherNoAdvice });
    const text = strings.join(' ').toLowerCase();
    for (const word of ['lost', 'deleted', 'gone', 'incomplete']) {
      expect(text).not.toContain(word);
    }
  });

  it('other-key accounts get their own block under the first, and k does not count them', () => {
    const r = report(none(1), other(2));
    expect(r.withoutKeyCount).toBe(1);
    expect(r.otherKeyCount).toBe(1);
    expect(r.title).toBe("A key isn't in this backup");
    expect(r.otherKey?.text).toBe(
      "This phone also holds a different key for this account that isn't in this backup."
    );
    expect(r.otherKey?.advice).toBe(
      "Keep this wallet installed so this key isn't lost."
    );
    expect(r.otherKey?.rows.map((x) => x.reason)).toEqual([
      "Its own key is in this backup. A different key stored with it isn't.",
    ]);
    // The without-key block does not list it.
    expect(r.withoutKey?.rows.map((x) => x.label)).toEqual(['none-1']);
  });

  it('several other-key accounts: the plural text with j and the plural advice', () => {
    const r = report(none(1), other(2), other(3));
    expect(r.otherKeyCount).toBe(2);
    expect(r.otherKey?.text).toBe(
      "This phone also holds different keys for these 2 accounts that aren't in this backup."
    );
    expect(r.otherKey?.advice).toBe(
      "Keep this wallet installed so these keys aren't lost."
    );
    // The title follows k, not j.
    expect(r.title).toBe("A key isn't in this backup");
  });

  it('k is 0: the other-key block stands alone with the title for ITS count', () => {
    const one = report(other(1));
    expect(one.withoutKey).toBeUndefined();
    expect(one.withoutKeyCount).toBe(0);
    expect(one.title).toBe("A key isn't in this backup");
    expect(one.otherKey?.rows).toHaveLength(1);
    const several = report(other(1), other(2));
    expect(several.title).toBe("Some keys aren't in this backup");
    expect(several.withoutKey).toBeUndefined();
  });

  it('Android saved alert counts k only, singular and plural, and k = 0 has its own line', () => {
    const base = 'Backup saved to your selected folder.';
    expect(androidSavedAlertText(buildBackupReport({}))).toBe(base);
    expect(androidSavedAlertText(report(none(1)))).toBe(
      `${base} It doesn't have the key for 1 account.`
    );
    expect(androidSavedAlertText(report(none(1), bad(2), other(3)))).toBe(
      `${base} It doesn't have the keys for 2 accounts.`
    );
    expect(androidSavedAlertText(report(other(1), other(2)))).toBe(
      `${base} It doesn't have every key on this phone.`
    );
  });

  it('the restore confirmation line counts k only; none when k is 0', () => {
    expect(restoreConfirmationKeysLine(undefined)).toBeNull();
    expect(restoreConfirmationKeysLine({ leftOut: [] })).toBeNull();
    expect(restoreConfirmationKeysLine({ leftOut: [none(1)] })).toBe(
      "This backup doesn't have the key for 1 account. It'll be added without it."
    );
    expect(
      restoreConfirmationKeysLine({ leftOut: [none(1), bad(2), other(3)] })
    ).toBe(
      "This backup doesn't have the keys for 2 accounts. They'll be added without them."
    );
    expect(
      restoreConfirmationKeysLine({ leftOut: [other(1), other(2)] })
    ).toBeNull();
  });
});

import {
  CONFIRM_WORD,
  FORGOT_LINK_TEXT,
  NOTHING_TO_ADD_TEXT,
  NO_KEYS_TEXT,
  REMOVE_BUTTON_TEXT,
  forgottenPinConsentText,
  forgottenPinIncompleteWarning,
  forgottenPinNotAddedRows,
  forgottenPinUnavailable,
} from '../forgottenPinCopy';
import algosdk from 'algosdk';

const addr = () => algosdk.generateAccount().addr.toString();
const plan = (over = {}) => ({
  total: 3,
  addable: 3,
  addableWithKey: 2,
  notAdded: [] as { label?: string; address: string }[],
  ...over,
});

describe('TASK-504: forgotten-PIN copy (product, verbatim)', () => {
  it('pins the link, the buttons and the confirm word', () => {
    expect(FORGOT_LINK_TEXT).toBe("I don't remember it");
    expect(REMOVE_BUTTON_TEXT).toBe('Remove old PIN and restore');
    expect(CONFIRM_WORD).toBe('REMOVE');
  });

  it('complete file, every record added', () => {
    expect(forgottenPinConsentText(plan())).toBe(
      "Restore without your PIN? 3 accounts from your backup will be restored, and you'll set a new PIN. Any other key on this phone that's locked with your old PIN, such as an account added after this backup, can't be opened by the app."
    );
  });

  it('some records not added', () => {
    expect(forgottenPinConsentText(plan({ addable: 2 }))).toBe(
      "Restore without your PIN? 2 of the 3 accounts in your backup will be restored, and you'll set a new PIN. The rest are listed below, with the reason. Any other key on this phone that's locked with your old PIN, such as an account added after this backup, can't be opened by the app."
    );
  });

  it('lists each record that is not added, with its address and reason', () => {
    const rows = forgottenPinNotAddedRows(
      plan({ notAdded: [{ label: 'Bad one', address: addr() }] })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Bad one');
    expect(rows[0].shortAddress.length).toBeGreaterThan(0);
    expect(rows[0].text).toBe(
      'Not added. The backup is missing details this account needs.'
    );
  });

  it('the incomplete warning names M accounts by label and address', () => {
    const w = forgottenPinIncompleteWarning({
      incomplete: {
        leftOut: [
          { address: addr(), label: 'Lost', reason: 'key-unreadable' },
          { address: addr(), reason: 'no-key-on-device' },
        ],
      },
    });
    expect(w?.text).toBe(
      "This backup doesn't have the keys for these 2 accounts. Those keys may exist only on this phone, locked with your old PIN. If you remove the PIN, the app won't be able to open them. If you might remember it, or can find a complete backup, cancel now."
    );
    expect(w?.rows.map((r) => r.label)).toEqual(['Lost', 'Account']);
    expect(forgottenPinIncompleteWarning({})).toBeNull();
  });

  it('an account whose own key IS in the file is in the list, with the reason line, and the warning text is unchanged (db99d45f item 3)', () => {
    const w = forgottenPinIncompleteWarning({
      incomplete: {
        leftOut: [
          { address: addr(), label: 'Lost', reason: 'key-unreadable' },
          { address: addr(), label: 'Has own', reason: 'other-key-on-device' },
        ],
      },
    });
    // M includes it (2), exactly as before.
    expect(w?.text).toContain('for these 2 accounts');
    expect(w?.rows.map((r) => [r.label, r.text])).toEqual([
      ['Lost', undefined],
      [
        'Has own',
        "Its own key is in this backup. A different key stored with it isn't.",
      ],
    ]);
  });

  it('the step is unavailable for a file that adds nothing or holds no key', () => {
    expect(
      forgottenPinUnavailable(plan({ addable: 0, addableWithKey: 0 }))
    ).toBe(NOTHING_TO_ADD_TEXT);
    expect(forgottenPinUnavailable(plan({ addableWithKey: 0 }))).toBe(
      NO_KEYS_TEXT
    );
    expect(forgottenPinUnavailable(plan())).toBeNull();
    expect(NOTHING_TO_ADD_TEXT).toBe(
      "There's nothing in this backup that can be added to this phone. Your PIN is still here, and nothing has changed."
    );
    expect(NO_KEYS_TEXT).toBe(
      "This backup doesn't hold any account keys, so restoring it without your PIN wouldn't give you back any account you can sign with. Your PIN is still on this phone, and nothing has changed. Enter your PIN, or use a backup that has your keys."
    );
  });
});

/**
 * TASK-45 — `isBackupVerified` / `needsBackupVerification` fail-closed contract.
 *
 * These two predicates are the only sanctioned reads of `backupVerified`; the
 * Home warning banner is driven by them. Every ambiguous input must resolve to
 * "not verified" so the warning can never be wrongly suppressed on an account
 * whose phrase the user has not confirmed.
 */

import {
  AccountType,
  backupVerifiedAtImport,
  isBackupVerified,
  needsBackupVerification,
  type StandardAccountMetadata,
} from '../wallet';

function standard(
  overrides: Partial<StandardAccountMetadata> = {}
): StandardAccountMetadata {
  return {
    id: 'acc-1',
    address: 'ADDR',
    publicKey: 'ff',
    type: AccountType.STANDARD,
    isHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsed: '2026-01-01T00:00:00.000Z',
    mnemonic: '',
    hasBackup: true,
    backupVerified: false,
    ...overrides,
  };
}

describe('isBackupVerified', () => {
  it('is true only for an explicit true', () => {
    expect(isBackupVerified(standard({ backupVerified: true }))).toBe(true);
    expect(isBackupVerified(standard({ backupVerified: false }))).toBe(false);
  });

  it('fails closed for a legacy record with the field missing', () => {
    const legacy = standard();
    delete (legacy as Partial<StandardAccountMetadata>).backupVerified;
    expect(isBackupVerified(legacy)).toBe(false);
  });

  it('fails closed for a truthy non-boolean', () => {
    expect(
      isBackupVerified(
        standard({ backupVerified: 'yes' as unknown as boolean })
      )
    ).toBe(false);
    expect(
      isBackupVerified(standard({ backupVerified: 1 as unknown as boolean }))
    ).toBe(false);
  });

  it('never treats hasBackup as verification', () => {
    expect(
      isBackupVerified(standard({ hasBackup: true, backupVerified: false }))
    ).toBe(false);
  });

  it('is false for null / undefined / non-standard accounts', () => {
    expect(isBackupVerified(null)).toBe(false);
    expect(isBackupVerified(undefined)).toBe(false);
    expect(isBackupVerified({ type: AccountType.WATCH })).toBe(false);
    expect(isBackupVerified({ type: AccountType.LEDGER })).toBe(false);
    expect(isBackupVerified({ type: AccountType.REMOTE_SIGNER })).toBe(false);
  });
});

describe('needsBackupVerification', () => {
  it('is true for an unverified standard account', () => {
    expect(needsBackupVerification(standard())).toBe(true);
  });

  it('is false once verified', () => {
    expect(needsBackupVerification(standard({ backupVerified: true }))).toBe(
      false
    );
  });

  it('is false for account types with no recovery phrase of ours', () => {
    // A watch / Ledger / remote-signer account has no phrase this app could ask
    // the user to confirm, so it must never raise the warning.
    expect(needsBackupVerification({ type: AccountType.WATCH })).toBe(false);
    expect(needsBackupVerification({ type: AccountType.LEDGER })).toBe(false);
    expect(needsBackupVerification({ type: AccountType.REMOTE_SIGNER })).toBe(
      false
    );
    expect(needsBackupVerification({ type: AccountType.REKEYED })).toBe(true);
  });

  it('is false when there is no active account', () => {
    expect(needsBackupVerification(null)).toBe(false);
    expect(needsBackupVerification(undefined)).toBe(false);
  });
});

// Both metadata-bearing types use literal verification; unresolved custody reminds.
describe('shared reminder policy', () => {
  it.each(Object.values(AccountType))(
    'keeps %s results for every flag combination',
    (type) => {
      for (const hasBackup of [undefined, false, true]) {
        for (const backupVerified of [undefined, false, true, 'yes', 1, null]) {
          const account = {
            type,
            hasBackup,
            backupVerified,
          } as unknown as Parameters<typeof isBackupVerified>[0];
          const verified =
            (type === AccountType.STANDARD || type === AccountType.REKEYED) &&
            backupVerified === true;
          expect(isBackupVerified(account)).toBe(verified);
          expect(needsBackupVerification(account)).toBe(
            (type === AccountType.STANDARD || type === AccountType.REKEYED) &&
              !verified
          );
        }
      }
    }
  );
});

// TASK-556: the single import-time decision. Typing a phrase in proves the user
// holds it; pasting one does not, and generating one does not until the quiz is
// passed.
describe('backupVerifiedAtImport', () => {
  it('quiz counts only when the quiz was passed', () => {
    expect(backupVerifiedAtImport('quiz', true)).toBe(true);
    expect(backupVerifiedAtImport('quiz', false)).toBe(false);
    expect(backupVerifiedAtImport('quiz')).toBe(false);
    expect(backupVerifiedAtImport('quiz', 'true' as unknown as boolean)).toBe(
      false
    );
  });

  it('an entered phrase counts as backed up', () => {
    expect(backupVerifiedAtImport('entered-phrase')).toBe(true);
  });

  it.each(['pasted', 'qr', 'private-key', 'restore'] as const)(
    '%s never counts, even with quizPassed',
    (source) => {
      expect(backupVerifiedAtImport(source)).toBe(false);
      expect(backupVerifiedAtImport(source, true)).toBe(false);
    }
  );

  it('an unknown source at runtime fails closed to boolean false', () => {
    expect(backupVerifiedAtImport('typed-ish' as never)).toBe(false);
    expect(backupVerifiedAtImport('typed-ish' as never, true)).toBe(false);
  });
});

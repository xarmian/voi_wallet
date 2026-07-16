// Unit tests for isSoftwareAuthError (PR6.1) — the shared predicate that lets the
// signing-recovery wrapper and the transaction auth controller recognize a
// software-key auth failure and route it to PIN entry INSTEAD of retrying it as a
// recoverable Ledger error / showing "unlock your Ledger device".

import { isSoftwareAuthError } from '../authErrors';
import { AuthenticationRequiredError } from '@/types/wallet';

describe('isSoftwareAuthError', () => {
  it('matches the AuthenticationRequiredError type (preserved through keyManager)', () => {
    expect(
      isSoftwareAuthError(
        new AuthenticationRequiredError('PIN required to access private key')
      )
    ).toBe(true);
    // Type match holds even with an unrelated message.
    expect(
      isSoftwareAuthError(new AuthenticationRequiredError('anything'))
    ).toBe(true);
  });

  it('matches the stable software-auth message strings after the type is erased by wrapping', () => {
    // SecureKeyManager wraps unknown errors as a plain Error; the message survives.
    expect(
      isSoftwareAuthError(
        new Error(
          'Failed to retrieve private key: PIN required to access private key'
        )
      )
    ).toBe(true);
    expect(isSoftwareAuthError(new Error('Invalid PIN'))).toBe(true);
    expect(
      isSoftwareAuthError(new Error('Failed to access private key with PIN'))
    ).toBe(true);
  });

  it('is case-insensitive on the message', () => {
    expect(
      isSoftwareAuthError(new Error('PIN REQUIRED TO ACCESS PRIVATE KEY'))
    ).toBe(true);
  });

  it('does NOT match Ledger / unrelated signing errors', () => {
    expect(
      isSoftwareAuthError(new Error('Please unlock your Ledger device'))
    ).toBe(false);
    expect(
      isSoftwareAuthError(new Error('Open the Algorand app on your Ledger'))
    ).toBe(false);
    expect(isSoftwareAuthError(new Error('Network request failed'))).toBe(
      false
    );
    // "pin" alone (e.g. a Ledger PIN prompt) must NOT be treated as a software
    // auth error — only the specific software-key markers count.
    expect(
      isSoftwareAuthError(new Error('Enter your PIN on the Ledger device'))
    ).toBe(false);
  });

  it('handles non-Error inputs safely', () => {
    expect(isSoftwareAuthError(null)).toBe(false);
    expect(isSoftwareAuthError(undefined)).toBe(false);
    expect(isSoftwareAuthError('invalid pin')).toBe(true);
    expect(isSoftwareAuthError({})).toBe(false);
  });
});

/**
 * Unit tests for src/utils/errorMapping.ts (TASK-41 / U-05).
 *
 * The finding this closes: ~41 call sites across 24 screens piped raw
 * `error.message` from algosdk/algod/Mimir straight into user-facing alerts,
 * so a failed send showed `TransactionPool.Remember: transaction ABC:
 * overspend (account XYZ, data ...)`.
 *
 * The tests are grouped by the guarantees the UI now depends on:
 *
 *  1. **Secret safety** — the hard one. A mnemonic, private key or seed must
 *     never survive into a string that can reach an alert, a log or a crash
 *     report. These use REAL 25-word Algorand mnemonic shapes and real key
 *     lengths, not toy inputs.
 *  2. **Real algod/indexer strings** map to actionable plain language. The
 *     inputs are the literal strings algod emits.
 *  3. **Typed errors** are honoured ahead of message text, including the
 *     deduped `RemoteSignerRequiredError`.
 *  4. **Never blank, never raw** — an unknown failure still produces a
 *     non-empty message plus sanitized details, and an HTML error body never
 *     reaches the user.
 *  5. **Purity / surface-agnosticism** — no RN `Alert` binding; `toErrorAlert`
 *     returns plain data so the extension target's console-only adapter works.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  getUserFacingMessage,
  isAccountNotFoundError,
  isLedgerTransportError,
  isPermissionDeniedError,
  isRetryableError,
  isUserRejectionError,
  mapError,
  redactSecrets,
  sanitizeDetails,
  toErrorAlert,
} from '../errorMapping';
import {
  AccountNotFoundError,
  AuthenticationRequiredError,
  InvalidAddressError,
  InvalidMnemonicError,
  LedgerAppNotOpenError,
  LedgerDeviceNotConnectedError,
  LedgerUserRejectedError,
  RemoteSignerRequiredError,
} from '@/types/wallet';
import {
  NetworkError,
  NetworkId,
  NetworkUnavailableError,
} from '@/types/network';

/** A real-shaped 25-word Algorand mnemonic (never used for a real account). */
const MNEMONIC_25 =
  'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual invest';

/** 64 hex chars — the length of a raw Ed25519 seed / private key. */
const HEX_KEY =
  'a3f1c09b7d2e4856193a7c5f0b8d6e42fa19c73b850d2e6417ff9a03c5b81d2e';

// ===========================================================================
// 1. Secret safety — nothing below may leak key material
// ===========================================================================

describe('redactSecrets — key material never reaches a user-facing string', () => {
  it('removes a bare 25-word mnemonic run', () => {
    const out = redactSecrets(
      `Import failed for phrase ${MNEMONIC_25} at step 3`
    );

    expect(out).not.toContain('abandon ability able');
    expect(out).not.toContain('actress actual invest');
    expect(out).toContain('[redacted]');
    // Surrounding context survives so the message stays diagnosable. The run
    // matcher deliberately over-reaches into adjacent lowercase words rather
    // than risk leaving a mnemonic word behind.
    expect(out).toContain('Import');
    expect(out).toContain('at step 3');
  });

  it('removes a labelled mnemonic even when it is short', () => {
    const out = redactSecrets('mnemonic: abandon ability able about');
    expect(out).not.toContain('abandon');
    expect(out).toContain('[redacted]');
  });

  it.each([
    ['private key', `private key: ${HEX_KEY}`],
    ['secret key', `secretKey=${HEX_KEY}`],
    ['seed phrase', `seed phrase: ${MNEMONIC_25}`],
    ['passphrase', 'passphrase: hunter2-correct-horse'],
    ['password', 'password=s3cr3t!'],
    ['pin', 'pin: 482913'],
  ])('removes a labelled %s', (_label, input) => {
    const out = redactSecrets(input);
    expect(out).toContain('[redacted]');
    expect(out).not.toMatch(/hunter2|s3cr3t|482913/);
    expect(out).not.toContain(HEX_KEY);
    expect(out).not.toContain('abandon ability');
  });

  it('removes a bare 64-char hex key with no label at all', () => {
    const out = redactSecrets(`decrypt failed for ${HEX_KEY}`);
    expect(out).not.toContain(HEX_KEY);
    expect(out).toContain('[redacted]');
  });

  it('removes a bare base64 key blob', () => {
    // 88 base64 chars — the encoded length of an Ed25519 secret key.
    const b64 = 'A'.repeat(86) + '==';
    const out = redactSecrets(`sk=${b64}`);
    expect(out).not.toContain(b64);
    expect(out).toContain('[redacted]');
  });

  it('leaves ordinary error prose and public addresses untouched', () => {
    const address = 'TESTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const input = `overspend (account ${address}, data {})`;
    expect(redactSecrets(input)).toBe(input);
  });

  it('is safe on empty input', () => {
    expect(redactSecrets('')).toBe('');
  });
});

describe('mapError — secrets never survive into message, userAction or details', () => {
  const leaky = [
    new Error(`Failed to decrypt with mnemonic ${MNEMONIC_25}`),
    new Error(`SecureStore write failed: privateKey=${HEX_KEY}`),
    new Error(`unexpected token in {"mnemonic":"${MNEMONIC_25}"}`),
  ];

  it.each(leaky.map((e, i) => [i, e]))(
    'case %i leaks nothing into any user-visible field',
    (_i, error) => {
      const mapped = mapError(error as Error);
      const everything = [
        mapped.message,
        mapped.userAction,
        mapped.details ?? '',
        mapped.code ?? '',
      ].join(' ');

      expect(everything).not.toContain(HEX_KEY);
      expect(everything).not.toContain('abandon ability able');
      expect(everything).not.toContain('actress actual invest');
    }
  );

  it('toErrorAlert output is likewise clean', () => {
    const { title, message } = toErrorAlert(
      new Error(`boom: ${MNEMONIC_25} / ${HEX_KEY}`)
    );
    expect(`${title} ${message}`).not.toContain(HEX_KEY);
    expect(`${title} ${message}`).not.toContain('abandon ability able');
  });

  it('does not echo an invalid recovery phrase back to the user', () => {
    const mapped = mapError(
      new InvalidMnemonicError(`Invalid mnemonic phrase: ${MNEMONIC_25}`)
    );
    expect(mapped.message).not.toContain('abandon');
    expect(mapped.details).toBeUndefined();
    expect(mapped.message.toLowerCase()).toContain('recovery phrase');
  });
});

// ===========================================================================
// 2. Real algod / indexer strings → actionable plain language
// ===========================================================================

describe('mapError — notorious algod strings become plain language', () => {
  it('maps a TransactionPool overspend to insufficient funds', () => {
    const mapped = mapError(
      new Error(
        'TransactionPool.Remember: transaction JYQ...: overspend (account TESTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, data {_struct:{} Status:Offline MicroAlgos:{Raw:1000}}, tried to spend {5000000})'
      )
    );

    expect(mapped.type).toBe('insufficient_funds');
    expect(mapped.isGeneric).toBe(false);
    expect(mapped.retryable).toBe(false);
    // None of the algod jargon survives.
    expect(mapped.message).not.toMatch(/TransactionPool|_struct|MicroAlgos/);
    expect(mapped.message.toLowerCase()).toContain('balance');
    expect(mapped.userAction).not.toBe('');
  });

  it('prefers minimum-balance over overspend when algod reports both', () => {
    // algod emits "overspend" AND "below min" for this case; the min-balance
    // explanation is the actionable one, so it must win.
    const mapped = mapError(
      new Error(
        'TransactionPool.Remember: transaction ABC: account TESTADDR balance 98000 below min 100000 (0 assets)'
      )
    );

    expect(mapped.type).toBe('min_balance');
    expect(mapped.message.toLowerCase()).toContain('minimum balance');
  });

  it('maps a missing asset holding to an opt-in explanation', () => {
    const mapped = mapError(
      new Error(
        'TransactionPool.Remember: transaction ABC: asset 12345 missing from TESTADDR'
      )
    );
    expect(mapped.type).toBe('not_opted_in');
    expect(mapped.message.toLowerCase()).toContain('opted in');
  });

  it('maps a dead transaction to an expiry explanation', () => {
    const mapped = mapError(
      new Error(
        'TransactionPool.Remember: txn dead: round 5000 outside of 4000--4900'
      )
    );
    expect(mapped.type).toBe('transaction_expired');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a duplicate submission', () => {
    const mapped = mapError(
      new Error('TransactionPool.Remember: transaction already in ledger: ABC')
    );
    expect(mapped.type).toBe('duplicate_transaction');
    expect(mapped.retryable).toBe(false);
  });

  it('maps a below-threshold fee', () => {
    const mapped = mapError(
      new Error('TransactionPool.Remember: fee 500 below threshold 1000')
    );
    expect(mapped.type).toBe('fee_too_low');
    expect(mapped.retryable).toBe(true);
  });

  it('maps a logic eval failure to a contract rejection', () => {
    const mapped = mapError(
      new Error(
        'TransactionPool.Remember: transaction ABC: logic eval error: assert failed pc=453. Details: app=12345'
      )
    );
    expect(mapped.type).toBe('app_rejected');
    expect(mapped.message).not.toContain('pc=453');
  });

  it('maps a bad authorizer to a rejected transaction', () => {
    const mapped = mapError(
      new Error(
        'transaction ABC: should have been authorized by TESTADDR but was actually authorized by OTHERADDR'
      )
    );
    expect(mapped.type).toBe('transaction_rejected');
  });

  it('maps "account does not exist" to account_not_found', () => {
    const mapped = mapError(
      new Error(
        'failed to retrieve information from the ledger: account does not exist'
      )
    );
    expect(mapped.type).toBe('account_not_found');
    expect(mapped.retryable).toBe(false);
  });
});

describe('mapError — connectivity and HTTP', () => {
  it("maps React Native's fetch failure to offline", () => {
    const mapped = mapError(new TypeError('Network request failed'));
    expect(mapped.type).toBe('offline');
    expect(mapped.retryable).toBe(true);
    expect(mapped.userAction.toLowerCase()).toContain('connection');
  });

  it('maps an AbortError to a timeout', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(mapError(abort).type).toBe('timeout');
  });

  it.each([
    [429, 'rate_limited'],
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'server_error'],
    [404, 'not_found'],
    [403, 'permission_denied'],
    [400, 'validation'],
  ])('maps HTTP %i to %s', (status, expected) => {
    // Shaped like MimirApiError / EnvoiApiError: a `status` field.
    const err = Object.assign(new Error('Request failed'), { status });
    expect(mapError(err).type).toBe(expected);
  });

  it('reads statusCode too (SwapServiceError / SnowballApiError shape)', () => {
    const err = Object.assign(new Error('Deflex quote failed'), {
      statusCode: 503,
      name: 'DeflexApiError',
    });
    const mapped = mapError(err);
    expect(mapped.type).toBe('server_error');
    expect(mapped.status).toBe(503);
  });

  it('prefers an on-chain reason over the HTTP status that carried it', () => {
    // algod returns 400 for every rejection; "overspend" is far more useful
    // than "the service rejected the request".
    const err = Object.assign(
      new Error('TransactionPool.Remember: overspend (account TESTADDR)'),
      { status: 400 }
    );
    expect(mapError(err).type).toBe('insufficient_funds');
  });

  it('reads the algod reason out of response.body.message', () => {
    const err = Object.assign(new Error('Request failed with status 400'), {
      status: 400,
      response: {
        status: 400,
        body: { message: 'account does not exist' },
      },
    });
    expect(mapError(err).type).toBe('account_not_found');
  });

  it('surfaces the code carried by a rebuilt retry error', () => {
    // The shape mimir/price/algorand-price now throw after retry exhaustion.
    const err = Object.assign(
      new Error('All 3 attempts failed. Last error: Network request failed'),
      { name: 'MimirApiError', code: 'NETWORK_ERROR' }
    );
    const mapped = mapError(err);
    expect(mapped.type).toBe('offline');
    expect(mapped.code).toBe('NETWORK_ERROR');
  });

  it('surfaces the status a retry loop preserved (token-mapping fix)', () => {
    // Before TASK-41 token-mapping dropped this status and every failure
    // degraded to the generic message.
    const err = Object.assign(
      new Error('Failed after 3 attempts: API returned status 503'),
      { name: 'TokenMappingAPIError', code: 'API_ERROR', status: 503 }
    );
    const mapped = mapError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.type).toBe('server_error');
    expect(mapped.isGeneric).toBe(false);
  });
});

describe('mapError — WalletConnect and Ledger', () => {
  it.each([
    "No matching key. session topic doesn't exist: abc123",
    'Proposal expired',
    'Session not found',
  ])('maps WalletConnect session failure: %s', (msg) => {
    expect(mapError(new Error(msg)).type).toBe('session_expired');
  });

  it('maps a user rejection from a dApp request', () => {
    expect(mapError(new Error('User rejected the request')).type).toBe(
      'user_rejected'
    );
  });

  it('maps Ledger status word 0x6985 to a user rejection', () => {
    expect(
      mapError(
        new Error('Ledger device: Condition of use not satisfied (0x6985)')
      ).type
    ).toBe('user_rejected');
  });

  it('maps a locked Ledger', () => {
    const mapped = mapError(new Error('Ledger device: Locked device (0x5515)'));
    expect(mapped.type).toBe('ledger');
    expect(mapped.userAction.toLowerCase()).toContain('unlock');
  });

  it('maps a disconnected Ledger transport', () => {
    const mapped = mapError(
      new Error('DisconnectedDevice: Ledger device disconnected')
    );
    expect(mapped.type).toBe('ledger');
    expect(mapped.retryable).toBe(true);
  });
});

// ===========================================================================
// 3. Typed errors win over message text
// ===========================================================================

describe('mapError — typed errors', () => {
  it('honours AccountNotFoundError regardless of its message', () => {
    const mapped = mapError(new AccountNotFoundError('nope'));
    expect(mapped.type).toBe('account_not_found');
    expect(mapped.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('honours AuthenticationRequiredError', () => {
    const mapped = mapError(new AuthenticationRequiredError());
    expect(mapped.type).toBe('auth_required');
    expect(mapped.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('honours InvalidAddressError', () => {
    expect(mapError(new InvalidAddressError()).type).toBe('invalid_address');
  });

  it.each([
    [new LedgerUserRejectedError(), 'user_rejected'],
    [new LedgerAppNotOpenError(), 'ledger'],
    [new LedgerDeviceNotConnectedError(), 'ledger'],
  ])('maps Ledger typed error to %s', (error, expected) => {
    expect(mapError(error).type).toBe(expected);
  });

  it('distinguishes the two Ledger device states by their user action', () => {
    expect(mapError(new LedgerAppNotOpenError()).userAction).toMatch(
      /algorand app/i
    );
    expect(mapError(new LedgerDeviceNotConnectedError()).userAction).toMatch(
      /reconnect/i
    );
  });

  it('honours NetworkUnavailableError over the generic NetworkError', () => {
    expect(
      mapError(new NetworkUnavailableError(NetworkId.VOI_MAINNET, 'indexer'))
        .type
    ).toBe('server_error');
    expect(mapError(new NetworkError('boom', NetworkId.VOI_MAINNET)).type).toBe(
      'offline'
    );
  });

  it('maps RemoteSignerRequiredError to the QR-signing prompt', () => {
    const mapped = mapError(
      new RemoteSignerRequiredError({ accountAddress: 'TESTADDR' })
    );
    expect(mapped.type).toBe('remote_signer_required');
    expect(mapped.code).toBe('REMOTE_SIGNER_REQUIRED');
    expect(mapped.userAction.toLowerCase()).toContain('qr');
  });
});

describe('RemoteSignerRequiredError — single definition', () => {
  /**
   * `signingRouter` and `unifiedSigner` each used to declare their own class
   * with this same `name`, so an `instanceof` check against one silently
   * returned `false` for an error thrown by the other. Both now re-export this
   * one declaration; the cross-module identity assertion lives in
   * `services/remoteSigner/__tests__/signingRouter.test.ts`, which already has
   * the native-module mocks those service modules need.
   */
  it('supports both original construction shapes', () => {
    const withAddress = new RemoteSignerRequiredError({
      accountAddress: 'TESTADDR',
      signerDeviceId: 'device-1',
    });
    expect(withAddress.accountAddress).toBe('TESTADDR');
    expect(withAddress.signerDeviceId).toBe('device-1');
    expect(withAddress.message).toContain('TESTADDR');
    expect(withAddress.message.toLowerCase()).toContain('qr');

    const withMessage = new RemoteSignerRequiredError({
      message: 'This account uses remote signing via QR codes.',
    });
    expect(withMessage.message).toMatch(/remote signing via qr/i);
    expect(withMessage.name).toBe('RemoteSignerRequiredError');
  });
});

// ===========================================================================
// 4. Never blank, never a raw HTTP body
// ===========================================================================

describe('mapError — degradation of unknown failures', () => {
  it('never returns an empty message or userAction', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      '',
      0,
      {},
      [],
      new Error(''),
      'plain string failure',
      { weird: true },
    ];

    for (const input of inputs) {
      const mapped = mapError(input);
      expect(mapped.message.length).toBeGreaterThan(0);
      expect(mapped.userAction.length).toBeGreaterThan(0);
      expect(typeof mapped.type).toBe('string');
    }
  });

  it('flags an unrecognised failure as generic and attaches details', () => {
    const mapped = mapError(new Error('EPIPE: broken pipe in widget 7'));
    expect(mapped.isGeneric).toBe(true);
    expect(mapped.details).toContain('broken pipe');
  });

  it('omits details when a rule matched (the message is already actionable)', () => {
    const mapped = mapError(new Error('TransactionPool.Remember: overspend'));
    expect(mapped.isGeneric).toBe(false);
    expect(mapped.details).toBeUndefined();
  });

  it('can be asked for details even when a rule matched', () => {
    const mapped = mapError(new Error('TransactionPool.Remember: overspend'), {
      includeDetailsWhenMapped: true,
    });
    expect(mapped.details).toContain('overspend');
  });

  it('uses a caller-supplied fallback message for unknown failures only', () => {
    expect(
      mapError(new Error('weird internal thing'), {
        fallbackMessage: "We couldn't prepare this transaction.",
      }).message
    ).toBe("We couldn't prepare this transaction.");

    // A recognised failure keeps its specific message.
    expect(
      mapError(new Error('Network request failed'), {
        fallbackMessage: "We couldn't prepare this transaction.",
      }).message
    ).not.toBe("We couldn't prepare this transaction.");
  });

  it('never shows a raw HTML error body', () => {
    const html =
      '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><hr>nginx/1.18.0</body></html>';
    const mapped = mapError(new Error(html));

    const everything = `${mapped.message} ${mapped.userAction} ${mapped.details ?? ''}`;
    expect(everything).not.toContain('<html');
    expect(everything).not.toContain('<h1>');
    expect(everything).not.toContain('nginx');
  });

  it('strips stray markup out of details', () => {
    expect(sanitizeDetails('failed <b>hard</b> at <i>step 2</i>')).toBe(
      'failed hard at step 2'
    );
  });

  it('caps details length so an alert cannot be flooded', () => {
    const details = sanitizeDetails('x'.repeat(5000));
    expect(details).toBeDefined();
    expect(details!.length).toBeLessThanOrEqual(280);
  });

  it('returns undefined details for values carrying no information', () => {
    expect(sanitizeDetails(undefined)).toBeUndefined();
    expect(sanitizeDetails(null)).toBeUndefined();
    expect(sanitizeDetails('')).toBeUndefined();
    expect(sanitizeDetails({})).toBeUndefined();
    expect(sanitizeDetails('   ')).toBeUndefined();
  });

  it('survives an object with a throwing/ circular shape', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => mapError(circular)).not.toThrow();
    expect(mapError(circular).message.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5. Presentation helpers — surface-agnostic
// ===========================================================================

describe('presentation helpers', () => {
  it('getUserFacingMessage joins the reason and the action', () => {
    const text = getUserFacingMessage(new Error('Network request failed'));
    expect(text).toContain("Couldn't reach the network");
    expect(text.toLowerCase()).toContain('internet connection');
    expect(text.trim()).toBe(text);
  });

  it('toErrorAlert returns plain data, not a native call', () => {
    const alert = toErrorAlert(new TypeError('Network request failed'));
    expect(alert).toEqual({
      title: expect.any(String),
      message: expect.any(String),
    });
    expect(alert.title).toBe('No Connection');
    expect(alert.message.length).toBeGreaterThan(0);
  });

  it('appends the details expander only for unrecognised failures', () => {
    expect(toErrorAlert(new Error('quantum flux desync')).message).toContain(
      'Details:'
    );
    expect(
      toErrorAlert(new Error('TransactionPool.Remember: overspend')).message
    ).not.toContain('Details:');
  });

  it('honours an explicit title override', () => {
    expect(
      toErrorAlert(new Error('Network request failed'), {
        title: 'Swap Failed',
      }).title
    ).toBe('Swap Failed');
  });

  it('falls back to a non-empty title for an unmapped type', () => {
    expect(toErrorAlert(new Error('quantum flux desync')).title).toBe(
      'Something Went Wrong'
    );
  });

  it('does not import react-native (works on the extension target)', () => {
    // The mapper must stay surface-agnostic: the extension AlertAdapter only
    // console.logs, so anything bound to RN Alert would be invisible there.
    const source = readFileSync(
      join(__dirname, '..', 'errorMapping.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/from ['"]react-native['"]/);
    expect(source).not.toMatch(/require\(['"]react-native['"]\)/);
    // No executable call into a native alert surface (comments may mention it).
    expect(source).not.toMatch(/^\s*Alert\.alert\(/m);
  });
});

// ===========================================================================
// 6. Predicates that replaced string-matching control flow
// ===========================================================================

describe('predicates', () => {
  it('isAccountNotFoundError matches the algod string and the typed error', () => {
    expect(isAccountNotFoundError(new Error('account does not exist'))).toBe(
      true
    );
    expect(isAccountNotFoundError(new AccountNotFoundError())).toBe(true);
    expect(isAccountNotFoundError(new Error('Network request failed'))).toBe(
      false
    );
    expect(isAccountNotFoundError(undefined)).toBe(false);
  });

  it('isUserRejectionError matches dApp and Ledger rejections', () => {
    expect(isUserRejectionError(new Error('User rejected the request'))).toBe(
      true
    );
    expect(isUserRejectionError(new LedgerUserRejectedError())).toBe(true);
    expect(isUserRejectionError(new Error('overspend'))).toBe(false);
  });

  it('isLedgerTransportError is case-insensitive and covers DisconnectedDevice', () => {
    // The old inline checks were case-sensitive `includes('Transport')` /
    // `includes('COMMUNICATION_ERROR')` and missed both of these.
    expect(isLedgerTransportError(new Error('DisconnectedDevice'))).toBe(true);
    expect(isLedgerTransportError(new Error('communication_error'))).toBe(true);
    expect(isLedgerTransportError(new Error('TransportError: closed'))).toBe(
      true
    );
    expect(isLedgerTransportError(new Error('user cancelled'))).toBe(false);
  });

  it('isLedgerTransportError does NOT swallow a device status word', () => {
    // TransportStatusError carries an APDU status (locked device, wrong app),
    // which IS recoverable by retrying. Classifying it as a dead transport
    // would abort the retry loop on the first attempt.
    const statusErr = Object.assign(
      new Error('Ledger device: Locked device (0x5515)'),
      { name: 'TransportStatusError', statusCode: 0x5515 }
    );
    expect(isLedgerTransportError(statusErr)).toBe(false);
  });

  it('isPermissionDeniedError covers lowercase and HTTP 401/403', () => {
    expect(isPermissionDeniedError(new Error('Permission denied'))).toBe(true);
    expect(isPermissionDeniedError(new Error('permission not granted'))).toBe(
      true
    );
    expect(isPermissionDeniedError(new Error('Unauthorized'))).toBe(true);
    expect(
      isPermissionDeniedError(Object.assign(new Error('nope'), { status: 403 }))
    ).toBe(true);
    expect(isPermissionDeniedError(new Error('Network request failed'))).toBe(
      false
    );
    // A message that mentions a GRANTED permission is not a denial — treating
    // it as one would abort a retry loop that could still succeed.
    expect(
      isPermissionDeniedError(
        new Error('Bluetooth permission granted but scan failed')
      )
    ).toBe(false);
  });

  it('isRetryableError mirrors the mapped projection', () => {
    expect(isRetryableError(new Error('Network request failed'))).toBe(true);
    expect(
      isRetryableError(new Error('TransactionPool.Remember: overspend'))
    ).toBe(false);
  });
});

/**
 * Central error-mapping utility (TASK-41 / U-05).
 *
 * The app throws ~40 typed error classes and forwards raw SDK/HTTP failures
 * straight into user-facing alerts. algod, indexer and Mimir errors are
 * notoriously cryptic — `TransactionPool.Remember: transaction ...: overspend
 * (account ...)`, bare HTTP bodies, `logic eval error: assert failed pc=...` —
 * so users saw unactionable jargon at the most stressful moments (a failed
 * send, a failed swap, a failed opt-in).
 *
 * This module translates any thrown value into a single stable projection:
 *
 *     { type, message, retryable, userAction }
 *
 * mirroring `simpleLedgerManager.getState()` (`simpleLedgerManager.ts:96-101`),
 * which was already the closest shape to what the UI needs, plus optional
 * `code` / `status` / `details` for diagnostics and a details expander.
 *
 * Design constraints:
 *
 *  - **Pure.** No React, no React Native, no service singletons, no network,
 *    no platform adapters. It imports only pure type modules. That keeps it
 *    unit-testable and keeps it working on the extension/web target, whose
 *    `ExtensionAlertAdapter` merely `console.log`s.
 *  - **Surface-agnostic.** It never calls `Alert`. `toErrorAlert()` returns
 *    plain `{ title, message }` data so a caller can route it through RN
 *    `Alert`, a toast, inline `setError`, or the platform alert adapter.
 *  - **Never leaks secrets.** Every string that can reach the UI passes
 *    through `redactSecrets()`, which strips mnemonics, private/secret keys,
 *    seeds, passphrases and PINs before they can land in an alert body, a log
 *    line or a crash report.
 *  - **Never shows a raw HTTP body.** Unknown errors degrade to a generic
 *    message plus a sanitized, tag-stripped, length-capped `details` string —
 *    never a blank message and never a raw response body.
 *
 * Typed errors are matched by `instanceof` where the defining module is pure
 * (`@/types/wallet`, `@/types/network`, `@/types/social`) and structurally by
 * `name` + `status`/`statusCode`/`code` for service-level errors
 * (`MimirApiError`, `SwapServiceError`, `EnvoiApiError`, `TokenMappingError`,
 * …) whose modules pull in network config and must not be imported here.
 */

import {
  AccountError,
  AccountNotFoundError,
  AuthenticationRequiredError,
  InvalidAddressError,
  InvalidMnemonicError,
  LedgerAccountError,
  LedgerAppNotOpenError,
  LedgerDeviceNotConnectedError,
  LedgerUserRejectedError,
  RemoteSignerRequiredError,
} from '@/types/wallet';
import { NetworkError, NetworkUnavailableError } from '@/types/network';
import { FriendError } from '@/types/social';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Stable, machine-readable classification of a failure. Screens may branch on
 * this instead of string-matching `error.message` (which is what
 * `AccountInfoScreen` and the Ledger retry loops used to do).
 */
export type MappedErrorType =
  // connectivity / transport
  | 'offline'
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'not_found'
  // funds / on-chain rejections
  | 'insufficient_funds'
  | 'min_balance'
  | 'not_opted_in'
  | 'transaction_expired'
  | 'duplicate_transaction'
  | 'fee_too_low'
  | 'app_rejected'
  | 'transaction_rejected'
  // account state
  | 'account_not_found'
  | 'invalid_address'
  | 'invalid_amount'
  | 'validation'
  // signing / auth
  | 'user_rejected'
  | 'auth_required'
  | 'ledger'
  | 'remote_signer_required'
  | 'watch_account'
  | 'permission_denied'
  // session
  | 'session_expired'
  // fallback
  | 'unknown';

export interface MappedError {
  /** Stable classification — safe to branch on. */
  type: MappedErrorType;
  /** Plain-language, user-facing sentence. Never empty, never raw jargon. */
  message: string;
  /** Whether retrying the same operation could plausibly succeed. */
  retryable: boolean;
  /** Concrete next step for the user. Never empty. */
  userAction: string;
  /** Stable code carried by the underlying typed error, when it had one. */
  code?: string;
  /** HTTP-ish status carried by the underlying error, when it had one. */
  status?: number;
  /**
   * Sanitized underlying detail for a "Details" expander: secrets redacted,
   * HTML stripped, length-capped. `undefined` when nothing useful remains.
   */
  details?: string;
  /**
   * True when no rule matched and the generic fallback was used. UIs should
   * surface `details` in this case so the failure is still diagnosable.
   */
  isGeneric: boolean;
}

export interface MapErrorOptions {
  /**
   * Replaces the generic fallback message when nothing matches. Use it to give
   * the unknown case operation-specific wording ("Failed to prepare the
   * transaction."). Ignored when a rule matches.
   */
  fallbackMessage?: string;
  /** Title for `toErrorAlert` when the mapped type has no better one. */
  fallbackTitle?: string;
  /**
   * Include the sanitized `details` string even when a rule matched. Off by
   * default: a matched rule already produced an actionable message and the raw
   * text is usually noise.
   */
  includeDetailsWhenMapped?: boolean;
}

// ---------------------------------------------------------------------------
// Redaction — nothing below this line may emit unredacted text
// ---------------------------------------------------------------------------

const REDACTED = '[redacted]';

/**
 * `label: value` / `label=value` for anything that names key material.
 * Deliberately greedy on the label side so `secret key`, `private-key`,
 * `seed phrase` etc. all match.
 */
const LABELLED_SECRET_RE =
  /\b(mnemonic|recovery[\s_-]?phrase|seed[\s_-]?phrase|seed|private[\s_-]?key|privkey|secret[\s_-]?key|secretkey|passphrase|password|passcode|\bpin\b)\b\s*(?:is|:|=)\s*\S+/gi;

/** 64+ hex chars — an Ed25519 secret key, a seed, or a raw key blob. */
const LONG_HEX_RE = /\b[0-9a-fA-F]{64,}\b/g;

/** 60+ base64 chars — a base64-encoded key/seed (an sk is 88 chars). */
const LONG_BASE64_RE = /[A-Za-z0-9+/]{60,}={0,2}/g;

/**
 * A run of 12+ consecutive short lowercase words — the shape of a BIP-39 /
 * Algorand mnemonic (all words are 3-8 lowercase letters). Real error prose
 * essentially never produces 12 unbroken words in that alphabet, and erring
 * toward over-redaction is correct here.
 */
const MNEMONIC_RUN_RE = /\b(?:[a-z]{3,8}[ \t]+){11,}[a-z]{3,8}\b/g;

/** Markup, so an HTML error page can never be pasted into an alert body. */
const HTML_TAG_RE = /<[^>]*>/g;
const HTML_DOC_RE = /<!doctype html|<html[\s>]/i;

/**
 * Strip anything that could be key material from a string before it reaches a
 * user-facing surface, a log, or a crash report.
 *
 * Order matters: labelled secrets are removed first (so `mnemonic: abandon
 * abandon …` collapses to one token), then raw high-entropy blobs, then bare
 * mnemonic-shaped word runs.
 */
export function redactSecrets(input: string): string {
  if (!input) return '';
  return input
    .replace(LABELLED_SECRET_RE, (_m, label: string) => `${label}: ${REDACTED}`)
    .replace(MNEMONIC_RUN_RE, REDACTED)
    .replace(LONG_HEX_RE, REDACTED)
    .replace(LONG_BASE64_RE, REDACTED);
}

const MAX_DETAILS_LENGTH = 280;

/**
 * Turn arbitrary error text into something safe to show in a details
 * expander: secrets redacted, markup stripped, whitespace collapsed, length
 * capped. Returns `undefined` when nothing meaningful survives.
 */
export function sanitizeDetails(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  let text = typeof input === 'string' ? input : safeStringify(input);
  if (!text) return undefined;

  if (HTML_DOC_RE.test(text)) {
    // A full HTML error page carries no user value at all.
    return 'The server returned an unexpected response.';
  }

  text = redactSecrets(text)
    .replace(HTML_TAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return undefined;
  if (text.length > MAX_DETAILS_LENGTH) {
    return `${text.slice(0, MAX_DETAILS_LENGTH - 1).trimEnd()}…`;
  }
  return text;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  try {
    const json = JSON.stringify(value);
    // `{}` carries no information; treat it as nothing.
    return !json || json === '{}' ? '' : json;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Structural extraction
// ---------------------------------------------------------------------------

interface ErrorFacts {
  /** Constructor/`name` of the thrown value, when it is an Error. */
  name: string;
  /** Raw message text (unredacted — internal use only). */
  rawMessage: string;
  /** Every text fragment worth pattern-matching, lowercased. */
  haystack: string;
  status?: number;
  code?: string;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Collect the metadata the rules need. `status`/`statusCode` and `code` are
 * read structurally so service errors keep working without importing their
 * (impure) defining modules: `MimirApiError.status`, `SwapServiceError`/
 * `SnowballApiError`/`DeflexApiError.statusCode`, `EnvoiApiError.status`,
 * `TokenMappingError.code`, algosdk's `response.status`.
 */
function collectFacts(error: unknown): ErrorFacts {
  const any = error as any;

  const rawMessage =
    error instanceof Error
      ? error.message || ''
      : typeof error === 'string'
        ? error
        : safeStringify(error);

  const name =
    (error instanceof Error ? error.name : undefined) ||
    readString(any?.name) ||
    '';

  const status =
    readNumber(any?.status) ??
    readNumber(any?.statusCode) ??
    readNumber(any?.response?.status);

  const code =
    readString(any?.code) ??
    readString(any?.data?.code) ??
    readString(any?.response?.body?.code);

  // algosdk surfaces the real algod reason under response.body.message; the
  // outer `message` is often just "Network request failed" or a status line.
  const fragments = [
    rawMessage,
    readString(any?.response?.body?.message),
    readString(any?.response?.text),
    readString(any?.data?.message),
    error instanceof Error && any?.cause instanceof Error
      ? any.cause.message
      : undefined,
    name,
    code,
  ].filter(
    (part): part is string => typeof part === 'string' && part.length > 0
  );

  return {
    name,
    rawMessage,
    haystack: fragments.join(' | ').toLowerCase(),
    status,
    code,
  };
}

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

type Rule = {
  type: MappedErrorType;
  message: string;
  retryable: boolean;
  userAction: string;
};

const GENERIC: Rule = {
  type: 'unknown',
  message: 'Something went wrong.',
  retryable: true,
  userAction:
    'Please try again. If it keeps happening, check the details below.',
};

const OFFLINE: Rule = {
  type: 'offline',
  message: "Couldn't reach the network.",
  retryable: true,
  userAction: 'Check your internet connection and try again.',
};

const TIMEOUT: Rule = {
  type: 'timeout',
  message: 'The request took too long and was cancelled.',
  retryable: true,
  userAction: 'Check your connection and try again.',
};

const RATE_LIMITED: Rule = {
  type: 'rate_limited',
  message: 'Too many requests were sent in a short time.',
  retryable: true,
  userAction: 'Wait a moment and try again.',
};

const SERVER_ERROR: Rule = {
  type: 'server_error',
  message: 'The service is temporarily unavailable.',
  retryable: true,
  userAction: 'Please try again in a few moments.',
};

const INSUFFICIENT_FUNDS: Rule = {
  type: 'insufficient_funds',
  message: "This account doesn't have enough balance for this transaction.",
  retryable: false,
  userAction:
    'Lower the amount or add funds, remembering to leave enough to cover the network fee.',
};

const MIN_BALANCE: Rule = {
  type: 'min_balance',
  message:
    'This would drop the account below the minimum balance the network requires.',
  retryable: false,
  userAction:
    'Send a smaller amount, or add funds. Each asset and app you opt into raises the minimum balance.',
};

const NOT_OPTED_IN: Rule = {
  type: 'not_opted_in',
  message: 'The account has not opted in to this asset.',
  retryable: false,
  userAction:
    'Opt in to the asset first — the recipient must opt in before they can receive it.',
};

const TRANSACTION_EXPIRED: Rule = {
  type: 'transaction_expired',
  message: 'The transaction expired before it reached the network.',
  retryable: true,
  userAction: 'Please try again to build a fresh transaction.',
};

const DUPLICATE_TRANSACTION: Rule = {
  type: 'duplicate_transaction',
  message: 'This transaction has already been submitted.',
  retryable: false,
  userAction: 'Check your transaction history before sending it again.',
};

const FEE_TOO_LOW: Rule = {
  type: 'fee_too_low',
  message: 'The network fee was too low for current conditions.',
  retryable: true,
  userAction: 'Please try again — a new fee will be calculated.',
};

const APP_REJECTED: Rule = {
  type: 'app_rejected',
  message: 'The smart contract rejected this transaction.',
  retryable: false,
  userAction:
    'Check the amounts and that the account meets the contract’s requirements, then try again.',
};

const TRANSACTION_REJECTED: Rule = {
  type: 'transaction_rejected',
  message: 'The network rejected this transaction.',
  retryable: false,
  userAction: 'Review the transaction details and try again.',
};

const ACCOUNT_NOT_FOUND: Rule = {
  type: 'account_not_found',
  message: 'This account does not exist on the network yet.',
  retryable: false,
  userAction: 'Fund the account to activate it on this network.',
};

const INVALID_ADDRESS: Rule = {
  type: 'invalid_address',
  message: "That address isn't valid.",
  retryable: false,
  userAction: 'Double-check the recipient address and try again.',
};

const INVALID_AMOUNT: Rule = {
  type: 'invalid_amount',
  message: "That amount isn't valid.",
  retryable: false,
  userAction: 'Re-enter the amount and try again.',
};

const USER_REJECTED: Rule = {
  type: 'user_rejected',
  message: 'The request was rejected.',
  retryable: true,
  userAction: 'Approve the request to continue, or cancel to abort.',
};

const AUTH_REQUIRED: Rule = {
  type: 'auth_required',
  message: 'Your PIN or biometric confirmation is required to continue.',
  retryable: true,
  userAction: 'Authenticate and try again.',
};

const LEDGER_LOCKED: Rule = {
  type: 'ledger',
  message: 'Your Ledger device is locked.',
  retryable: true,
  userAction: 'Unlock your Ledger and try again.',
};

const LEDGER_APP_NOT_OPEN: Rule = {
  type: 'ledger',
  message: 'The Algorand app is not open on your Ledger.',
  retryable: true,
  userAction: 'Open the Algorand app on your Ledger and try again.',
};

const LEDGER_DISCONNECTED: Rule = {
  type: 'ledger',
  message: 'Your Ledger device is not connected.',
  retryable: true,
  userAction:
    'Reconnect and unlock your Ledger, open the Algorand app, then try again.',
};

const PERMISSION_DENIED: Rule = {
  type: 'permission_denied',
  message: 'The app is missing a permission it needs for this action.',
  retryable: false,
  userAction: 'Enable the required permission in your device Settings.',
};

const REMOTE_SIGNER_REQUIRED: Rule = {
  type: 'remote_signer_required',
  message: 'This account signs through a separate device using QR codes.',
  retryable: false,
  userAction: 'Use the QR signing flow to approve this transaction.',
};

const WATCH_ACCOUNT: Rule = {
  type: 'watch_account',
  message: 'This is a watch-only account and cannot sign transactions.',
  retryable: false,
  userAction: 'Switch to an account you control to continue.',
};

const SESSION_EXPIRED: Rule = {
  type: 'session_expired',
  message: 'The dApp connection is no longer active.',
  retryable: false,
  userAction: 'Reconnect to the dApp and try again.',
};

const NOT_FOUND: Rule = {
  type: 'not_found',
  message: "We couldn't find what you were looking for.",
  retryable: false,
  userAction: 'Check the details and try again.',
};

/**
 * Message-pattern table, evaluated in order against the lowercased haystack.
 *
 * The algod/indexer entries cover the strings users actually saw before this
 * task: `TransactionPool.Remember: ... overspend (account ... )`, `balance
 * ... below min`, `asset ... missing from`, `txn dead`, `transaction already
 * in ledger`, `logic eval error`, `should have been authorized by`.
 *
 * More specific patterns MUST precede more general ones (e.g. "below min"
 * before "overspend", since algod reports both together for an account that
 * would fall under its minimum balance).
 */
const MESSAGE_RULES: { pattern: RegExp; rule: Rule }[] = [
  // --- user cancellation (must beat generic "rejected" wording) ---
  {
    pattern: /user (rejected|disapproved|cancell?ed|denied)/,
    rule: USER_REJECTED,
  },
  {
    pattern: /\b0x6985\b|conditions of use not satisfied/,
    rule: USER_REJECTED,
  },
  {
    pattern: /request (was )?(rejected|cancell?ed) by (the )?user/,
    rule: USER_REJECTED,
  },

  // --- Ledger transport / device state ---
  { pattern: /\b0x5515\b|locked device|device is locked/, rule: LEDGER_LOCKED },
  {
    pattern: /\b0x6d00\b|\b0x6e00\b|app ?not ?open|open the algorand app/,
    rule: LEDGER_APP_NOT_OPEN,
  },
  {
    pattern:
      /disconnecteddevice|communication_error|transport(notsupported| error| is not)|no ledger device|ledger device is not connected/,
    rule: LEDGER_DISCONNECTED,
  },

  // --- permissions ---
  {
    pattern:
      /permission (denied|not granted)|bluetooth.*(permission|not authorized)|unauthorized access to/,
    rule: PERMISSION_DENIED,
  },

  // --- auth ---
  {
    pattern:
      /pin required|invalid pin|incorrect pin|failed to access private key|authentication required|biometric/,
    rule: AUTH_REQUIRED,
  },

  // --- account state ---
  {
    pattern:
      /account does not exist|no accounts found|account not found|account unknown/,
    rule: ACCOUNT_NOT_FOUND,
  },

  // --- on-chain rejections (order-sensitive) ---
  {
    pattern:
      /below min|minimum balance|min balance|would result in a balance below/,
    rule: MIN_BALANCE,
  },
  {
    pattern: /overspend|insufficient (funds|balance)|tried to spend/,
    rule: INSUFFICIENT_FUNDS,
  },
  {
    pattern:
      /missing from|asset .*not opted in|has not opted in|receiver error|must optin/,
    rule: NOT_OPTED_IN,
  },
  {
    pattern:
      /txn dead|transaction .*(expired|dead)|round .*(has passed|is in the past)|lastvalid/,
    rule: TRANSACTION_EXPIRED,
  },
  {
    pattern:
      /already in ledger|transactionpool\.remember: txn already|duplicate transaction/,
    rule: DUPLICATE_TRANSACTION,
  },
  {
    pattern: /fee \d* ?below threshold|fee too (small|low)/,
    rule: FEE_TOO_LOW,
  },
  {
    pattern: /logic eval error|assert failed|rejected by (logic|approval)/,
    rule: APP_REJECTED,
  },
  {
    pattern:
      /should have been authorized by|signature validation failed|invalid signature/,
    rule: TRANSACTION_REJECTED,
  },
  {
    pattern: /transactionpool\.remember|transaction (was )?rejected/,
    rule: TRANSACTION_REJECTED,
  },

  // --- validation ---
  {
    pattern: /invalid (algorand )?address|address .*is invalid|checksum/,
    rule: INVALID_ADDRESS,
  },
  {
    pattern:
      /invalid amount|amount must be|too many decimal|not a valid number/,
    rule: INVALID_AMOUNT,
  },

  // --- account types ---
  { pattern: /watch(-| )?only|watch accounts cannot/, rule: WATCH_ACCOUNT },
  { pattern: /remote sign|qr[- ]based signing/, rule: REMOTE_SIGNER_REQUIRED },

  // --- WalletConnect session ---
  {
    pattern:
      /no matching key|session topic doesn'?t exist|(session|proposal|pairing) (has )?expired|session not found/,
    rule: SESSION_EXPIRED,
  },

  // --- connectivity (last: these strings are the most generic) ---
  {
    pattern:
      /\btimeout\b|timed out|aborterror|the operation was aborted|\baborted\b/,
    rule: TIMEOUT,
  },
  {
    pattern:
      /network request failed|failed to fetch|network error|econnrefused|enotfound|etimedout|dns|offline|no internet|unable to connect/,
    rule: OFFLINE,
  },
];

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function ruleFromStatus(status: number): Rule | undefined {
  if (status === 401 || status === 403) {
    return {
      type: 'permission_denied',
      message: 'This request was not authorized by the service.',
      retryable: false,
      userAction: 'Please try again later, or contact support if it persists.',
    };
  }
  if (status === 404) return NOT_FOUND;
  if (status === 408) return TIMEOUT;
  if (status === 429) return RATE_LIMITED;
  if (status >= 500) return SERVER_ERROR;
  if (status >= 400) {
    return {
      type: 'validation',
      message: 'The service rejected the request.',
      retryable: false,
      userAction: 'Check the details you entered and try again.',
    };
  }
  return undefined;
}

/** Typed-error matching, first and highest-confidence pass. */
function ruleFromTypedError(error: unknown): Rule | undefined {
  if (error instanceof RemoteSignerRequiredError) return REMOTE_SIGNER_REQUIRED;
  if (error instanceof LedgerUserRejectedError) return USER_REJECTED;
  if (error instanceof LedgerAppNotOpenError) return LEDGER_APP_NOT_OPEN;
  if (error instanceof LedgerDeviceNotConnectedError)
    return LEDGER_DISCONNECTED;
  if (error instanceof LedgerAccountError) {
    return {
      type: 'ledger',
      message: 'Your Ledger device reported a problem.',
      retryable: true,
      userAction:
        'Make sure your Ledger is unlocked with the Algorand app open, then try again.',
    };
  }
  if (error instanceof AuthenticationRequiredError) return AUTH_REQUIRED;
  if (error instanceof AccountNotFoundError) return ACCOUNT_NOT_FOUND;
  if (error instanceof InvalidAddressError) return INVALID_ADDRESS;
  if (error instanceof InvalidMnemonicError) {
    return {
      type: 'validation',
      // Deliberately says nothing about the phrase itself.
      message: "That recovery phrase isn't valid.",
      retryable: false,
      userAction:
        'Check the word order and spelling, then enter the phrase again.',
    };
  }
  if (error instanceof NetworkUnavailableError) {
    return {
      type: 'server_error',
      message: 'This network is currently unavailable.',
      retryable: true,
      userAction: 'Try again shortly, or switch networks.',
    };
  }
  if (error instanceof NetworkError) return OFFLINE;
  if (error instanceof FriendError) {
    return {
      type: 'validation',
      message: 'That contact could not be saved.',
      retryable: false,
      userAction: 'Check the name or address and try again.',
    };
  }
  return undefined;
}

/**
 * Translate any thrown value into a stable, user-safe `{ type, message,
 * retryable, userAction }` projection.
 *
 * Resolution order: typed error → message patterns → HTTP status → generic
 * fallback. Message patterns run before status because algod returns a 400 for
 * every on-chain rejection, and "overspend" is far more useful than "the
 * service rejected the request".
 */
export function mapError(
  error: unknown,
  options: MapErrorOptions = {}
): MappedError {
  const facts = collectFacts(error);

  let rule = ruleFromTypedError(error);
  let matched = rule !== undefined;

  if (!rule && facts.haystack) {
    for (const entry of MESSAGE_RULES) {
      if (entry.pattern.test(facts.haystack)) {
        rule = entry.rule;
        matched = true;
        break;
      }
    }
  }

  if (!rule && facts.status !== undefined) {
    rule = ruleFromStatus(facts.status);
    matched = rule !== undefined;
  }

  if (!rule) {
    rule = options.fallbackMessage
      ? { ...GENERIC, message: options.fallbackMessage }
      : GENERIC;
  }

  const code =
    // A typed `code` is more useful than the mapped type, but the mapped type
    // is what the UI branches on, so keep both.
    facts.code ??
    (error instanceof AccountError ? error.code : undefined) ??
    undefined;

  const details =
    !matched || options.includeDetailsWhenMapped
      ? sanitizeDetails(facts.rawMessage)
      : undefined;

  return {
    type: rule.type,
    message: rule.message,
    retryable: rule.retryable,
    userAction: rule.userAction,
    code,
    status: facts.status,
    details,
    isGeneric: !matched,
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers (surface-agnostic — no RN imports)
// ---------------------------------------------------------------------------

/**
 * One-line user-facing string: the plain-language message followed by the
 * suggested action. Use for inline `setError(...)` and toasts.
 */
export function getUserFacingMessage(
  error: unknown,
  options: MapErrorOptions = {}
): string {
  const mapped = mapError(error, options);
  return `${mapped.message} ${mapped.userAction}`.trim();
}

export interface ErrorAlertContent {
  title: string;
  message: string;
}

const TITLE_BY_TYPE: Partial<Record<MappedErrorType, string>> = {
  offline: 'No Connection',
  timeout: 'Request Timed Out',
  rate_limited: 'Slow Down',
  server_error: 'Service Unavailable',
  insufficient_funds: 'Not Enough Balance',
  min_balance: 'Minimum Balance',
  not_opted_in: 'Opt-In Required',
  transaction_expired: 'Transaction Expired',
  duplicate_transaction: 'Already Submitted',
  fee_too_low: 'Fee Too Low',
  app_rejected: 'Rejected by Contract',
  transaction_rejected: 'Transaction Rejected',
  account_not_found: 'Account Not Found',
  invalid_address: 'Invalid Address',
  invalid_amount: 'Invalid Amount',
  user_rejected: 'Request Rejected',
  auth_required: 'Authentication Required',
  ledger: 'Ledger Device',
  remote_signer_required: 'QR Signing Required',
  watch_account: 'Watch-Only Account',
  permission_denied: 'Permission Needed',
  session_expired: 'Connection Expired',
  validation: 'Check Your Details',
  not_found: 'Not Found',
};

/**
 * Build `{ title, message }` for an alert/dialog. Deliberately returns plain
 * data rather than calling `Alert.alert`, so callers can route it through RN
 * `Alert`, a toast, or the platform alert adapter (the extension target's
 * adapter only `console.log`s).
 *
 * When the error was not recognised, the sanitized `details` are appended so a
 * generic message is still diagnosable — that is the "details expander" in an
 * alert-shaped surface.
 */
export function toErrorAlert(
  error: unknown,
  options: MapErrorOptions & { title?: string } = {}
): ErrorAlertContent {
  const mapped = mapError(error, options);
  const parts = [mapped.message, mapped.userAction].filter(Boolean);
  if (mapped.details) {
    parts.push(`Details: ${mapped.details}`);
  }
  return {
    title:
      options.title ??
      TITLE_BY_TYPE[mapped.type] ??
      options.fallbackTitle ??
      'Something Went Wrong',
    message: parts.join('\n\n'),
  };
}

// ---------------------------------------------------------------------------
// Predicates — replacements for ad-hoc `error.message.includes(...)` branching
// ---------------------------------------------------------------------------

/**
 * True when the failure means "this address has no on-chain account yet"
 * (algod's `account does not exist`). Replaces the raw string match in
 * `AccountInfoScreen`, which broke whenever algod reworded the error.
 */
export function isAccountNotFoundError(error: unknown): boolean {
  return mapError(error).type === 'account_not_found';
}

/** True when the user (or their device) explicitly declined the request. */
export function isUserRejectionError(error: unknown): boolean {
  return mapError(error).type === 'user_rejected';
}

/**
 * True for a Ledger transport/communication failure that will not be fixed by
 * retrying the same transport. Replaces the `COMMUNICATION_ERROR` / `Transport`
 * string matches in the Ledger retry loops.
 */
export function isLedgerTransportError(error: unknown): boolean {
  const facts = collectFacts(error);
  // `TransportStatusError` is an APDU *status word* from the device (locked,
  // wrong app, user rejected) — not a transport failure. It must NOT be
  // treated as one, or a retry loop that used to recover from a locked device
  // would give up on the first attempt.
  if (/transportstatuserror/.test(facts.haystack)) return false;
  // No trailing \b: `TransportError` and `TransportRaceCondition` are real
  // @ledgerhq error names and the old check (`message.includes('Transport')`)
  // was case-sensitive and missed the `name`.
  return /disconnecteddevice|communication_error|\btransport/.test(
    facts.haystack
  );
}

/**
 * True when the platform refused the operation for permission reasons (BLE,
 * USB, notifications). Replaces the `Permission` / `Unauthorized` string
 * matches in the Ledger transport retry loop.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  const facts = collectFacts(error);
  // A message that merely mentions a *granted* permission is not a denial —
  // treating it as one would abort a retry loop that could still succeed.
  if (/permissions?\s+(granted|allowed|ok)\b/.test(facts.haystack)) {
    return false;
  }
  if (/\bunauthorized\b|\bpermissions?\b|not authorized/.test(facts.haystack)) {
    return true;
  }
  return facts.status === 401 || facts.status === 403;
}

/** True when retrying the same operation could plausibly succeed. */
export function isRetryableError(error: unknown): boolean {
  return mapError(error).retryable;
}

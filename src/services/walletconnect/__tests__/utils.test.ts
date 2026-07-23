import { Buffer } from 'buffer';
import algosdk from 'algosdk';
import {
  parseWalletConnectUri,
  isWalletConnectUri,
  detectWalletConnectVersion,
  isWalletConnectV1Uri,
  isWalletConnectV2Uri,
  isWalletConnectPairingUri,
  isWalletConnectRequestUri,
  parseWalletConnectRequestUri,
  parseWalletConnectV1Uri,
  isVoiUri,
  validateAlgorandTransaction,
  getSignableAccounts,
  getTransactionSigningInfo,
  canSignWalletConnectTransaction,
  formatChainId,
  extractGenesisHash,
  formatAccountAddress,
  parseAccountAddress,
  isSessionExpired,
  formatSessionExpiry,
  truncateAddress,
  sanitizeMetadata,
  getNetworkByChainId,
  getChainDataByChainId,
  getNetworkNameByChainId,
  getNetworkCurrencyByChainId,
  detectRequestedChains,
  areRequiredChainsSupported,
  getChainIdByGenesisHash,
  getNetworkByGenesisHash,
} from '../utils';
import { VOI_CHAIN_DATA, ALGORAND_MAINNET_CHAIN_DATA } from '../config';
import { WalletConnectSession, SessionProposal } from '../types';
import {
  AccountType,
  AccountMetadata,
  BaseAccountMetadata,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  RemoteSignerAccountMetadata,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';

// ---------------------------------------------------------------------------
// Real crypto fixtures (DR-3: never fabricate key material or signatures).
// ---------------------------------------------------------------------------

// Genesis-hash hex values baked into utils.ts GENESIS_HASH_NETWORK_MAP. These
// are the real Voi / Algorand-mainnet genesis hashes; kept as hex so we can
// round-trip them through every encoding the decoder accepts.
const VOI_GENESIS_HEX =
  'af6d1f49023c8167bf90567388da2748f0972f0710987fe7c513af9e7b9e58e9';
const ALGO_GENESIS_HEX =
  'c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, 'hex'));
const hexToBase64 = (hex: string): string =>
  Buffer.from(hex, 'hex').toString('base64');
const hexToBase64Url = (hex: string): string =>
  hexToBase64(hex).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Real, checksum-valid Algorand/Voi addresses. algosdk 3.x returns `addr` as an
// Address object whose toString() is the 58-char base32 string.
const ADDR_A = algosdk.generateAccount().addr.toString();
const ADDR_B = algosdk.generateAccount().addr.toString();
const AUTH_ADDR = algosdk.generateAccount().addr.toString();

// Tamper a character *inside* the address payload so the checksum genuinely
// breaks (flipping only the final char can just alter padding bits and still
// validate). This yields a real "invalid address" negative.
function makeInvalidAddress(addr: string): string {
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const i = 10; // well inside the 32-byte public key region
  for (const c of base32) {
    if (c === addr[i]) continue;
    const candidate = addr.slice(0, i) + c + addr.slice(i + 1);
    if (!algosdk.isValidAddress(candidate)) return candidate;
  }
  return addr.slice(1); // practically unreachable fallback
}
const INVALID_ADDR = makeInvalidAddress(ADDR_A);

// A real, msgpack-encoded, base64 payment transaction. validateAlgorandTransaction
// only base64-decodes the payload, but building a genuine txn keeps the fixture
// faithful to what a dApp actually sends over WalletConnect.
function realTxnBase64(sender: string, receiver: string): string {
  const suggestedParams: algosdk.SuggestedParams = {
    fee: 1000,
    minFee: 1000,
    firstValid: 1,
    lastValid: 1001,
    genesisHash: hexToBytes(VOI_GENESIS_HEX),
    genesisID: 'voitest-v1',
    flatFee: true,
  };
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver,
    amount: 0,
    suggestedParams,
  });
  return Buffer.from(txn.toByte()).toString('base64');
}
const REAL_TXN_B64 = realTxnBase64(ADDR_A, ADDR_B);

// ---------------------------------------------------------------------------
// Account-metadata builders
// ---------------------------------------------------------------------------

function baseAccount(address: string): BaseAccountMetadata {
  return {
    id: `id-${address.slice(0, 6)}`,
    address,
    publicKey: '00'.repeat(32),
    type: AccountType.STANDARD,
    isHidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: '2024-01-01T00:00:00.000Z',
  };
}

function standardAccount(address: string): StandardAccountMetadata {
  return {
    ...baseAccount(address),
    type: AccountType.STANDARD,
    mnemonic: '', // no real mnemonic needed; type-selection only
    hasBackup: true,
    backupVerified: false,
  };
}

function watchAccount(address: string): WatchAccountMetadata {
  return { ...baseAccount(address), type: AccountType.WATCH };
}

function rekeyedAccount(
  address: string,
  canSign: boolean,
  authAddress: string
): RekeyedAccountMetadata {
  return {
    ...baseAccount(address),
    type: AccountType.REKEYED,
    authAddress,
    canSign,
  };
}

function ledgerAccount(address: string): LedgerAccountMetadata {
  return {
    ...baseAccount(address),
    type: AccountType.LEDGER,
    deviceId: 'device-1',
    derivationIndex: 0,
    derivationPath: "44'/283'/0'/0/0",
  };
}

function remoteSignerAccount(address: string): RemoteSignerAccountMetadata {
  return {
    ...baseAccount(address),
    type: AccountType.REMOTE_SIGNER,
    signerDeviceId: 'signer-1',
    pairedAt: '2024-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// SessionProposal builder
// ---------------------------------------------------------------------------

type Namespace = { chains?: string[]; methods: string[]; events: string[] };

function makeProposal(overrides: {
  requiredNamespaces?: Record<string, Namespace>;
  optionalNamespaces?: Record<string, Namespace>;
}): SessionProposal {
  return {
    id: 1,
    pairingTopic: 'pairing-topic',
    proposer: {
      publicKey: 'proposer-pk',
      metadata: { name: 'dApp', description: '', url: '', icons: [] },
    },
    requiredNamespaces: {},
    expiryTimestamp: 0,
    ...overrides,
  } as SessionProposal;
}

const VOI = VOI_CHAIN_DATA.chainId;
const ALGO = ALGORAND_MAINNET_CHAIN_DATA.chainId;
const UNSUPPORTED_CHAIN = 'eip155:1';

// Structurally-valid WalletConnect URIs built from SYNTHETIC, non-secret
// material. The `key`/`symKey`/`topic` values below are deliberately fake
// (self-describing placeholders) and are NOT real pairing secrets — they only
// need to survive parsing/round-tripping, so no live session key is embedded.
const SYNTHETIC_V1_KEY = 'synthetic-v1-key-not-a-real-secret';
const SYNTHETIC_SYMKEY = 'synthetic-symkey-not-a-real-secret';
const V1_URI =
  'wc:460d3411-9391-4521-9eb1-e7bb370e22e2@1' +
  '?bridge=https%3A%2F%2Fwallet-connect.perawallet.app' +
  `&key=${SYNTHETIC_V1_KEY}` +
  '&algorand=true';
const V2_PAIRING_URI = `wc:7f6e5d4c3b2a1908@2?relay-protocol=irn&symKey=${SYNTHETIC_SYMKEY}`;
const V2_REQUEST_URI =
  'wc:11112222@2/wc?requestId=1699999999999&sessionTopic=deadbeefcafef00d';

// ===========================================================================
// parseWalletConnectUri
// ===========================================================================

describe('parseWalletConnectUri', () => {
  it('parses topic, version and params from a v2 pairing URI', () => {
    const parsed = parseWalletConnectUri(V2_PAIRING_URI);
    expect(parsed.topic).toBe('7f6e5d4c3b2a1908');
    expect(parsed.version).toBe('2');
    expect(parsed.params).toEqual({
      'relay-protocol': 'irn',
      symKey: SYNTHETIC_SYMKEY,
    });
  });

  it('URLSearchParams-decodes percent-encoded param values', () => {
    const parsed = parseWalletConnectUri(V1_URI);
    expect(parsed.topic).toBe('460d3411-9391-4521-9eb1-e7bb370e22e2');
    expect(parsed.version).toBe('1');
    // %3A%2F%2F must be decoded back to :// by URLSearchParams.
    expect(parsed.params?.bridge).toBe('https://wallet-connect.perawallet.app');
    expect(parsed.params?.algorand).toBe('true');
  });

  it('returns topic/version with empty params when no query string present', () => {
    const parsed = parseWalletConnectUri('wc:justtopic@2');
    expect(parsed.topic).toBe('justtopic');
    expect(parsed.version).toBe('2');
    expect(parsed.params).toEqual({});
  });

  it('returns an empty object for a non-wc URI (malformed input)', () => {
    expect(parseWalletConnectUri('https://example.com')).toEqual({});
    expect(parseWalletConnectUri('')).toEqual({});
    expect(parseWalletConnectUri('voi:ADDRESS')).toEqual({});
  });

  it('treats a bare "wc:" prefix as a valid (empty) topic rather than throwing', () => {
    const parsed = parseWalletConnectUri('wc:');
    // startsWith('wc:') is satisfied, so it does not fall into the catch.
    expect(parsed).not.toEqual({});
    expect(parsed.topic).toBe('');
  });
});

// ===========================================================================
// isWalletConnectUri / isVoiUri
// ===========================================================================

describe('isWalletConnectUri', () => {
  it('is true only for the wc: scheme', () => {
    expect(isWalletConnectUri(V2_PAIRING_URI)).toBe(true);
    expect(isWalletConnectUri('wc:')).toBe(true);
    expect(isWalletConnectUri('voi:ADDR')).toBe(false);
    expect(isWalletConnectUri('WC:UPPER@2')).toBe(false); // case-sensitive
    expect(isWalletConnectUri('')).toBe(false);
  });
});

describe('isVoiUri', () => {
  it('is true only for the voi: scheme', () => {
    expect(isVoiUri('voi:ADDR')).toBe(true);
    expect(isVoiUri('wc:topic@2')).toBe(false);
    expect(isVoiUri('algorand://ADDR')).toBe(false);
  });
});

// ===========================================================================
// detectWalletConnectVersion + v1/v2 predicates
// ===========================================================================

describe('detectWalletConnectVersion', () => {
  it('detects explicit @1 and @2 version tags', () => {
    expect(detectWalletConnectVersion(V1_URI)).toBe(1);
    expect(detectWalletConnectVersion(V2_PAIRING_URI)).toBe(2);
  });

  it('falls back to bridge+key params for v1 when no version tag', () => {
    expect(
      detectWalletConnectVersion('wc:topic?bridge=https://b.app&key=abc')
    ).toBe(1);
  });

  it('falls back to relay-protocol / symKey params for v2 when no version tag', () => {
    expect(detectWalletConnectVersion('wc:topic?relay-protocol=irn')).toBe(2);
    expect(detectWalletConnectVersion('wc:topic?symKey=abc')).toBe(2);
  });

  it('returns null for unknown version with no recognizable params', () => {
    expect(detectWalletConnectVersion('wc:topic@9?foo=bar')).toBeNull();
    expect(detectWalletConnectVersion('wc:topic@2abc?x=1')).toBeNull();
  });

  it('returns null for non-wc URIs', () => {
    expect(detectWalletConnectVersion('https://x')).toBeNull();
    expect(detectWalletConnectVersion('')).toBeNull();
  });
});

describe('isWalletConnectV1Uri / isWalletConnectV2Uri', () => {
  it('classifies v1 URIs', () => {
    expect(isWalletConnectV1Uri(V1_URI)).toBe(true);
    expect(isWalletConnectV2Uri(V1_URI)).toBe(false);
  });

  it('classifies v2 URIs', () => {
    expect(isWalletConnectV2Uri(V2_PAIRING_URI)).toBe(true);
    expect(isWalletConnectV1Uri(V2_PAIRING_URI)).toBe(false);
  });

  it('classifies neither for non-wc / unknown URIs', () => {
    expect(isWalletConnectV1Uri('https://x')).toBe(false);
    expect(isWalletConnectV2Uri('https://x')).toBe(false);
    expect(isWalletConnectV1Uri('wc:t@9?x=1')).toBe(false);
    expect(isWalletConnectV2Uri('wc:t@9?x=1')).toBe(false);
  });
});

// ===========================================================================
// Pairing vs request URI classification
// ===========================================================================

describe('isWalletConnectPairingUri', () => {
  it('is true for a v2 pairing URI (relay-protocol, no /wc path)', () => {
    expect(isWalletConnectPairingUri(V2_PAIRING_URI)).toBe(true);
  });

  it('is false for a request URI even though it has a version', () => {
    expect(isWalletConnectPairingUri(V2_REQUEST_URI)).toBe(false);
  });

  it('is false when relay-protocol is present but a /wc path also is', () => {
    expect(isWalletConnectPairingUri('wc:topic@2/wc?relay-protocol=irn')).toBe(
      false
    );
  });

  it('is false without a relay-protocol param', () => {
    expect(isWalletConnectPairingUri('wc:topic@2?symKey=abc')).toBe(false);
  });

  it('is false for non-wc URIs', () => {
    expect(isWalletConnectPairingUri('https://x?relay-protocol=irn')).toBe(
      false
    );
  });
});

describe('isWalletConnectRequestUri', () => {
  it('is true for a request URI with /wc path + requestId + sessionTopic', () => {
    expect(isWalletConnectRequestUri(V2_REQUEST_URI)).toBe(true);
  });

  it('is false for a pairing URI (no /wc path)', () => {
    expect(isWalletConnectRequestUri(V2_PAIRING_URI)).toBe(false);
  });

  it('is false when /wc path is present but a required param is missing', () => {
    expect(isWalletConnectRequestUri('wc:topic@2/wc?requestId=1')).toBe(false);
    expect(isWalletConnectRequestUri('wc:topic@2/wc?sessionTopic=abc')).toBe(
      false
    );
  });

  it('is false for non-wc URIs', () => {
    expect(
      isWalletConnectRequestUri('https://x/wc?requestId=1&sessionTopic=y')
    ).toBe(false);
  });
});

// ===========================================================================
// parseWalletConnectRequestUri
// ===========================================================================

describe('parseWalletConnectRequestUri', () => {
  it('parses requestId (as a number) and sessionTopic', () => {
    const parsed = parseWalletConnectRequestUri(V2_REQUEST_URI);
    expect(parsed.requestId).toBe(1699999999999);
    expect(typeof parsed.requestId).toBe('number');
    expect(parsed.sessionTopic).toBe('deadbeefcafef00d');
  });

  it('leaves fields undefined when the query string is absent', () => {
    const parsed = parseWalletConnectRequestUri('wc:topic@2/wc');
    expect(parsed.requestId).toBeUndefined();
    expect(parsed.sessionTopic).toBeUndefined();
  });

  it('returns only the present field when the other is missing', () => {
    const parsed = parseWalletConnectRequestUri(
      'wc:topic@2/wc?sessionTopic=only'
    );
    expect(parsed.requestId).toBeUndefined();
    expect(parsed.sessionTopic).toBe('only');
  });

  it('yields NaN for a non-numeric requestId (lenient Number() parse)', () => {
    // Documents current permissive behavior: a malformed requestId is not
    // rejected, it is coerced to NaN. Callers must treat NaN as "no valid id".
    const parsed = parseWalletConnectRequestUri(
      'wc:topic@2/wc?requestId=notanumber&sessionTopic=abc'
    );
    expect(Number.isNaN(parsed.requestId)).toBe(true);
    expect(parsed.sessionTopic).toBe('abc');
  });
});

// ===========================================================================
// parseWalletConnectV1Uri
// ===========================================================================

describe('parseWalletConnectV1Uri', () => {
  it('parses a full v1 URI with decoded bridge and algorand flag', () => {
    const parsed = parseWalletConnectV1Uri(V1_URI);
    expect(parsed).not.toBeNull();
    expect(parsed!.topic).toBe('460d3411-9391-4521-9eb1-e7bb370e22e2');
    expect(parsed!.version).toBe('1');
    expect(parsed!.bridge).toBe('https://wallet-connect.perawallet.app');
    // The (synthetic) shared key is passed through verbatim (not decoded).
    expect(parsed!.key).toBe(SYNTHETIC_V1_KEY);
    expect(parsed!.algorand).toBe(true);
  });

  it('sets algorand=false when the flag is absent', () => {
    const parsed = parseWalletConnectV1Uri(
      'wc:topic@1?bridge=https%3A%2F%2Fb.app&key=deadbeef'
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.algorand).toBe(false);
  });

  it('returns null for a v2 URI', () => {
    expect(parseWalletConnectV1Uri(V2_PAIRING_URI)).toBeNull();
  });

  it('returns null when a v1 URI is missing bridge or key', () => {
    // version @1 is recognized, but the required bridge/key are absent.
    expect(parseWalletConnectV1Uri('wc:topic@1?key=deadbeef')).toBeNull();
    expect(
      parseWalletConnectV1Uri('wc:topic@1?bridge=https%3A%2F%2Fb.app')
    ).toBeNull();
  });

  it('returns null for a non-wc URI', () => {
    expect(parseWalletConnectV1Uri('https://x')).toBeNull();
  });
});

// ===========================================================================
// validateAlgorandTransaction
// ===========================================================================

describe('validateAlgorandTransaction', () => {
  it('accepts a real base64-encoded transaction', () => {
    expect(validateAlgorandTransaction({ txn: REAL_TXN_B64 })).toBe(true);
  });

  it('accepts a transaction with valid signers and authAddr', () => {
    expect(
      validateAlgorandTransaction({
        txn: REAL_TXN_B64,
        signers: [ADDR_A, ADDR_B],
        authAddr: AUTH_ADDR,
      })
    ).toBe(true);
  });

  it('rejects a missing or non-string txn field', () => {
    expect(validateAlgorandTransaction({ txn: '' })).toBe(false);
    expect(
      validateAlgorandTransaction({ txn: undefined as unknown as string })
    ).toBe(false);
    expect(validateAlgorandTransaction({ txn: 123 as unknown as string })).toBe(
      false
    );
  });

  it('rejects a txn string that base64-decodes to zero bytes', () => {
    // '!!!!' contains no base64 alphabet characters -> decodes to length 0.
    expect(validateAlgorandTransaction({ txn: '!!!!' })).toBe(false);
  });

  it('rejects a transaction whose signer is an invalid address', () => {
    expect(
      validateAlgorandTransaction({
        txn: REAL_TXN_B64,
        signers: [INVALID_ADDR],
      })
    ).toBe(false);
  });

  it('rejects a transaction whose authAddr is an invalid address', () => {
    expect(
      validateAlgorandTransaction({
        txn: REAL_TXN_B64,
        authAddr: INVALID_ADDR,
      })
    ).toBe(false);
  });

  it('accepts an empty signers array (multisig with no listed signers)', () => {
    expect(
      validateAlgorandTransaction({ txn: REAL_TXN_B64, signers: [] })
    ).toBe(true);
  });

  it('skips falsy signer entries rather than rejecting them', () => {
    // The implementation guards with `if (signer && !isValidAddress(signer))`,
    // so an empty-string signer is skipped (not validated) and the txn passes.
    expect(
      validateAlgorandTransaction({
        txn: REAL_TXN_B64,
        signers: ['', ADDR_A],
      })
    ).toBe(true);
  });

  it('tolerates a blank authAddr (treated as absent, not validated)', () => {
    // `if (txn.authAddr && !isValidAddress(txn.authAddr))` — a blank authAddr is
    // falsy, so it is treated as "no auth address" rather than rejected.
    expect(
      validateAlgorandTransaction({ txn: REAL_TXN_B64, authAddr: '' })
    ).toBe(true);
  });

  it('ignores a non-array signers field (shape guard), leaving the txn valid', () => {
    // `if (txn.signers && Array.isArray(txn.signers))` skips signer validation
    // entirely when signers is not an array, so the txn is not rejected here.
    expect(
      validateAlgorandTransaction({
        txn: REAL_TXN_B64,
        signers: 'not-an-array' as unknown as string[],
      })
    ).toBe(true);
  });

  it('is a base64-shape pre-check only: non-empty base64 garbage passes here', () => {
    // Documents the INTENTIONAL contract (utils.ts: "Basic validation - check if
    // transaction string is base64 encoded"). 'AAAA' is valid base64 that decodes
    // to 3 non-zero-length bytes, so this cheap gate accepts it. Full msgpack
    // validation is backstopped downstream by algosdk.decodeUnsignedTransaction
    // (see services/walletconnect/index.ts signing path). This assertion makes
    // the leniency explicit so no caller mistakes it for full txn validation.
    expect(validateAlgorandTransaction({ txn: 'AAAA' })).toBe(true);
  });
});

// ===========================================================================
// getSignableAccounts (signer selection)
// ===========================================================================

describe('getSignableAccounts', () => {
  it('includes STANDARD, LEDGER and REMOTE_SIGNER accounts (and only those)', () => {
    const std = standardAccount(ADDR_A);
    const led = ledgerAccount(ADDR_B);
    const rs = remoteSignerAccount(AUTH_ADDR);
    // Include a WATCH account so a pass-through implementation (returning every
    // input unchanged) would fail this exact-membership assertion.
    const watch = watchAccount(algosdk.generateAccount().addr.toString());
    const result = getSignableAccounts([std, led, watch, rs]);
    expect(result.map((a) => a.address)).toEqual([
      std.address,
      led.address,
      rs.address,
    ]);
  });

  it('excludes WATCH accounts', () => {
    const watch = watchAccount(ADDR_A);
    expect(getSignableAccounts([watch])).toEqual([]);
  });

  it('includes a REKEYED account only when canSign is true', () => {
    const canSign = rekeyedAccount(ADDR_A, true, AUTH_ADDR);
    const cannot = rekeyedAccount(ADDR_B, false, AUTH_ADDR);
    const result = getSignableAccounts([canSign, cannot]);
    expect(result).toEqual([canSign]);
  });

  it('filters a mixed set down to exactly the signable accounts', () => {
    const accounts: AccountMetadata[] = [
      standardAccount(ADDR_A),
      watchAccount(ADDR_B),
      rekeyedAccount(AUTH_ADDR, false, ADDR_A),
    ];
    const result = getSignableAccounts(accounts);
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe(ADDR_A);
  });

  it('returns an empty array for an empty input', () => {
    expect(getSignableAccounts([])).toEqual([]);
  });
});

// ===========================================================================
// getTransactionSigningInfo / canSignWalletConnectTransaction
// ===========================================================================

describe('getTransactionSigningInfo', () => {
  // Signer selection is driven by the ARC-0001 `authAddr`/`signers` request
  // metadata (which the wallet is being asked to sign with), NOT by decoding the
  // transaction's `snd`. This matches the production signing path in
  // services/walletconnect/index.ts, which likewise resolves the signer from
  // `authAddr`/`signers[0]`. These tests assert that intended behavior.
  it('resolves a STANDARD sender (from signers[0]) as signable', () => {
    const info = getTransactionSigningInfo(
      { txn: REAL_TXN_B64, signers: [ADDR_A] },
      [standardAccount(ADDR_A)]
    );
    expect(info.canSign).toBe(true);
    expect(info.signingAddress).toBe(ADDR_A);
    expect(info.isRekeyed).toBe(false);
    expect(info.accountInfo?.address).toBe(ADDR_A);
  });

  it('prefers authAddr over signers[0] when extracting the sender', () => {
    const info = getTransactionSigningInfo(
      { txn: REAL_TXN_B64, authAddr: ADDR_B, signers: [ADDR_A] },
      [standardAccount(ADDR_A), standardAccount(ADDR_B)]
    );
    expect(info.accountInfo?.address).toBe(ADDR_B);
    expect(info.signingAddress).toBe(ADDR_B);
  });

  it('reports a rekeyed sender that can sign, signing via the auth address', () => {
    const info = getTransactionSigningInfo(
      { txn: REAL_TXN_B64, signers: [ADDR_A] },
      [rekeyedAccount(ADDR_A, true, AUTH_ADDR)]
    );
    expect(info.canSign).toBe(true);
    expect(info.isRekeyed).toBe(true);
    expect(info.signingAddress).toBe(AUTH_ADDR);
  });

  it('reports a rekeyed sender that cannot sign with no signing address', () => {
    const info = getTransactionSigningInfo(
      { txn: REAL_TXN_B64, signers: [ADDR_A] },
      [rekeyedAccount(ADDR_A, false, AUTH_ADDR)]
    );
    expect(info.canSign).toBe(false);
    expect(info.isRekeyed).toBe(true);
    expect(info.signingAddress).toBeUndefined();
  });

  it('reports a WATCH sender as not signable', () => {
    const info = getTransactionSigningInfo(
      { txn: REAL_TXN_B64, signers: [ADDR_A] },
      [watchAccount(ADDR_A)]
    );
    expect(info.canSign).toBe(false);
    expect(info.isRekeyed).toBe(false);
    expect(info.accountInfo?.address).toBe(ADDR_A);
  });

  it('returns canSign=false when no signer metadata is supplied', () => {
    // With neither authAddr nor signers, the helper has no ARC-0001 signer to
    // resolve (it does not fall back to the encoded txn sender), so it reports
    // not-signable. This documents the metadata-driven contract explicitly.
    const info = getTransactionSigningInfo({ txn: REAL_TXN_B64 }, [
      standardAccount(ADDR_A),
    ]);
    expect(info.canSign).toBe(false);
    expect(info.accountInfo).toBeUndefined();
  });

  it('returns canSign=false when the sender is an invalid address', () => {
    const info = getTransactionSigningInfo(
      { txn: REAL_TXN_B64, authAddr: INVALID_ADDR },
      [standardAccount(ADDR_A)]
    );
    expect(info.canSign).toBe(false);
  });

  it('returns canSign=false when the sender is not among known accounts', () => {
    const info = getTransactionSigningInfo(
      { txn: REAL_TXN_B64, signers: [ADDR_A] },
      [standardAccount(ADDR_B)]
    );
    expect(info.canSign).toBe(false);
    expect(info.accountInfo).toBeUndefined();
  });

  // KNOWN DISCREPANCY (reported, left unfixed): getSignableAccounts treats
  // LEDGER and REMOTE_SIGNER accounts as signable, but getTransactionSigningInfo
  // has no case for them and falls through to `default: { canSign: false }`.
  // The function's own doc says it reports "whether signing is possible", and
  // for these account types signing IS possible (via device / paired signer),
  // so the intended result is canSign=true. These `it.failing` tests encode the
  // intended behavior; they will start passing (and must be converted to `it`)
  // once the source is fixed.
  it.failing(
    'SHOULD report a LEDGER sender as signable (intended behavior)',
    () => {
      const info = getTransactionSigningInfo(
        { txn: REAL_TXN_B64, signers: [ADDR_A] },
        [ledgerAccount(ADDR_A)]
      );
      expect(info.canSign).toBe(true);
    }
  );

  it.failing(
    'SHOULD report a REMOTE_SIGNER sender as signable (intended behavior)',
    () => {
      const info = getTransactionSigningInfo(
        { txn: REAL_TXN_B64, signers: [ADDR_A] },
        [remoteSignerAccount(ADDR_A)]
      );
      expect(info.canSign).toBe(true);
    }
  );
});

describe('canSignWalletConnectTransaction', () => {
  it('mirrors getTransactionSigningInfo.canSign', () => {
    expect(
      canSignWalletConnectTransaction(
        { txn: REAL_TXN_B64, signers: [ADDR_A] },
        [standardAccount(ADDR_A)]
      )
    ).toBe(true);
    expect(
      canSignWalletConnectTransaction(
        { txn: REAL_TXN_B64, signers: [ADDR_A] },
        [watchAccount(ADDR_A)]
      )
    ).toBe(false);
  });
});

// ===========================================================================
// Chain-id / account-address formatting helpers
// ===========================================================================

describe('formatChainId / extractGenesisHash', () => {
  it('round-trips a genesis hash through the algorand: chain id form', () => {
    const genesis = 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73k';
    const chainId = formatChainId(genesis);
    expect(chainId).toBe(`algorand:${genesis}`);
    expect(extractGenesisHash(chainId)).toBe(genesis);
  });

  it('returns null when extracting from a non-algorand chain id', () => {
    expect(extractGenesisHash('eip155:1')).toBeNull();
    expect(extractGenesisHash('')).toBeNull();
  });
});

describe('formatAccountAddress / parseAccountAddress', () => {
  it('round-trips a CAIP-10 style account address', () => {
    const formatted = formatAccountAddress(VOI, ADDR_A);
    expect(formatted).toBe(`${VOI}:${ADDR_A}`);
    const parsed = parseAccountAddress(formatted);
    expect(parsed).toEqual({ chainId: VOI, address: ADDR_A });
  });

  it('returns null when the formatted address does not have exactly 3 segments', () => {
    expect(parseAccountAddress('algorand:onlytwo')).toBeNull();
    expect(parseAccountAddress(ADDR_A)).toBeNull();
    expect(parseAccountAddress(`${VOI}:${ADDR_A}:extra`)).toBeNull();
  });
});

// ===========================================================================
// Session expiry helpers
// ===========================================================================

describe('isSessionExpired', () => {
  const session = (expiry: number): WalletConnectSession =>
    ({ expiry }) as WalletConnectSession;

  it('is false for a future expiry', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isSessionExpired(session(future))).toBe(false);
  });

  it('is true for a past expiry', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(isSessionExpired(session(past))).toBe(true);
  });
});

describe('formatSessionExpiry', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('formats a multi-day remaining window as "Xd Yh"', () => {
    const expiry = nowSec() + 2 * 86400 + 3 * 3600 + 600;
    expect(formatSessionExpiry(expiry)).toMatch(/^2d 3h$/);
  });

  it('formats an hours-only remaining window as "Xh"', () => {
    const expiry = nowSec() + 5 * 3600 + 600;
    expect(formatSessionExpiry(expiry)).toMatch(/^5h$/);
  });

  it('formats a minutes-only remaining window as "Xm"', () => {
    const expiry = nowSec() + 30 * 60;
    expect(formatSessionExpiry(expiry)).toMatch(/^\d+m$/);
  });

  it('returns "Expired" for a past expiry', () => {
    expect(formatSessionExpiry(nowSec() - 3600)).toBe('Expired');
  });
});

// ===========================================================================
// truncateAddress
// ===========================================================================

describe('truncateAddress', () => {
  it('truncates a long address with a default of 4 chars each side', () => {
    const out = truncateAddress(ADDR_A);
    expect(out).toBe(`${ADDR_A.slice(0, 4)}...${ADDR_A.slice(-4)}`);
    expect(out).toContain('...');
  });

  it('honors a custom char count', () => {
    const out = truncateAddress(ADDR_A, 6);
    expect(out).toBe(`${ADDR_A.slice(0, 6)}...${ADDR_A.slice(-6)}`);
  });

  it('returns short strings unchanged when length <= chars*2', () => {
    expect(truncateAddress('ABCDEFGH')).toBe('ABCDEFGH'); // 8 == 4*2
    expect(truncateAddress('ABCD', 4)).toBe('ABCD');
  });

  it('returns an empty string for an empty address', () => {
    expect(truncateAddress('')).toBe('');
  });
});

// ===========================================================================
// sanitizeMetadata
// ===========================================================================

describe('sanitizeMetadata', () => {
  it('passes through valid metadata', () => {
    const meta = {
      name: 'My dApp',
      description: 'Cool app',
      url: 'https://dapp.example',
      icons: ['https://dapp.example/icon.png'],
    };
    expect(sanitizeMetadata(meta)).toEqual(meta);
  });

  it('applies defaults for missing / nullish fields', () => {
    expect(sanitizeMetadata(undefined)).toEqual({
      name: 'Unknown dApp',
      description: 'No description provided',
      url: '',
      icons: [],
    });
    expect(sanitizeMetadata({})).toEqual({
      name: 'Unknown dApp',
      description: 'No description provided',
      url: '',
      icons: [],
    });
  });

  it('coerces a non-array icons field to an empty array', () => {
    const out = sanitizeMetadata({
      name: 'X',
      icons: 'not-an-array' as unknown as string[],
    });
    expect(out.icons).toEqual([]);
    expect(out.name).toBe('X');
  });
});

// ===========================================================================
// Chain-id lookups
// ===========================================================================

describe('getNetworkByChainId / getChainDataByChainId', () => {
  it('resolves the Voi chain id', () => {
    expect(getNetworkByChainId(VOI)).toBe(NetworkId.VOI_MAINNET);
    expect(getChainDataByChainId(VOI)).toBe(VOI_CHAIN_DATA);
  });

  it('resolves the Algorand mainnet chain id', () => {
    expect(getNetworkByChainId(ALGO)).toBe(NetworkId.ALGORAND_MAINNET);
    expect(getChainDataByChainId(ALGO)).toBe(ALGORAND_MAINNET_CHAIN_DATA);
  });

  it('returns null for an unsupported chain id', () => {
    expect(getNetworkByChainId(UNSUPPORTED_CHAIN)).toBeNull();
    expect(getChainDataByChainId(UNSUPPORTED_CHAIN)).toBeNull();
  });
});

describe('getNetworkNameByChainId / getNetworkCurrencyByChainId', () => {
  it('returns the display name and currency for supported chains', () => {
    expect(getNetworkNameByChainId(VOI)).toBe(VOI_CHAIN_DATA.name);
    expect(getNetworkCurrencyByChainId(VOI)).toBe('VOI');
    expect(getNetworkNameByChainId(ALGO)).toBe(
      ALGORAND_MAINNET_CHAIN_DATA.name
    );
    expect(getNetworkCurrencyByChainId(ALGO)).toBe('ALGO');
  });

  it('falls back to generic labels for unsupported chains', () => {
    expect(getNetworkNameByChainId(UNSUPPORTED_CHAIN)).toBe('Unknown Network');
    expect(getNetworkCurrencyByChainId(UNSUPPORTED_CHAIN)).toBe('TOKEN');
  });
});

// ===========================================================================
// Session-proposal chain detection
// ===========================================================================

describe('detectRequestedChains', () => {
  it('collects supported chains from required namespaces', () => {
    const proposal = makeProposal({
      requiredNamespaces: {
        algorand: { chains: [VOI, ALGO], methods: [], events: [] },
      },
    });
    expect(detectRequestedChains(proposal).sort()).toEqual([VOI, ALGO].sort());
  });

  it('collects from optional namespaces too and de-duplicates', () => {
    const proposal = makeProposal({
      requiredNamespaces: {
        algorand: { chains: [VOI], methods: [], events: [] },
      },
      optionalNamespaces: {
        algorand: { chains: [VOI, ALGO], methods: [], events: [] },
      },
    });
    const result = detectRequestedChains(proposal);
    expect(result).toHaveLength(2);
    expect(new Set(result)).toEqual(new Set([VOI, ALGO]));
  });

  it('filters out unsupported chains', () => {
    const proposal = makeProposal({
      requiredNamespaces: {
        algorand: {
          chains: [VOI, UNSUPPORTED_CHAIN],
          methods: [],
          events: [],
        },
      },
    });
    expect(detectRequestedChains(proposal)).toEqual([VOI]);
  });

  it('returns an empty array when namespaces are empty objects', () => {
    expect(detectRequestedChains(makeProposal({}))).toEqual([]);
  });

  it('returns an empty array when required/optional namespaces are undefined', () => {
    // Exercises the `if (proposal.requiredNamespaces)` / optional guards with a
    // genuinely-absent (undefined) value, not just an empty object.
    expect(
      detectRequestedChains(
        makeProposal({
          requiredNamespaces: undefined,
          optionalNamespaces: undefined,
        })
      )
    ).toEqual([]);
  });
});

describe('areRequiredChainsSupported', () => {
  // NOTE: this helper intentionally implements "at least ONE supported chain"
  // semantics (see its doc comment in utils.ts, and the sibling
  // detectRequestedChains which is documented to connect to dApps that request
  // some chains we don't support). These tests assert that deliberate product
  // behavior; whether to instead require ALL requested chains is a source-design
  // decision, out of scope for this test-only change.
  it('is true when a required namespace includes at least one supported chain', () => {
    const proposal = makeProposal({
      requiredNamespaces: {
        algorand: {
          chains: [VOI, UNSUPPORTED_CHAIN],
          methods: [],
          events: [],
        },
      },
    });
    expect(areRequiredChainsSupported(proposal)).toBe(true);
  });

  it('checks all required namespaces, not just the first', () => {
    // The supported namespace is listed AFTER an unsupported one; an
    // implementation that inspected only the first namespace would wrongly
    // return false here.
    const proposal = makeProposal({
      requiredNamespaces: {
        eip155: { chains: [UNSUPPORTED_CHAIN], methods: [], events: [] },
        algorand: { chains: [VOI], methods: [], events: [] },
      },
    });
    expect(areRequiredChainsSupported(proposal)).toBe(true);
  });

  it('is false when required chains are all unsupported', () => {
    const proposal = makeProposal({
      requiredNamespaces: {
        eip155: { chains: [UNSUPPORTED_CHAIN], methods: [], events: [] },
      },
    });
    expect(areRequiredChainsSupported(proposal)).toBe(false);
  });

  it('is false across multiple namespaces when none are supported', () => {
    const proposal = makeProposal({
      requiredNamespaces: {
        eip155: { chains: ['eip155:1'], methods: [], events: [] },
        cosmos: { chains: ['cosmos:cosmoshub-4'], methods: [], events: [] },
      },
    });
    expect(areRequiredChainsSupported(proposal)).toBe(false);
  });

  it('is true when requiredNamespaces is undefined (absent, not empty)', () => {
    // Exercises the explicit `!proposal.requiredNamespaces` early-return branch.
    expect(
      areRequiredChainsSupported(
        makeProposal({ requiredNamespaces: undefined })
      )
    ).toBe(true);
  });

  it('is true when requiredNamespaces is an empty object', () => {
    expect(areRequiredChainsSupported(makeProposal({}))).toBe(true);
  });

  it('is true when a required namespace specifies no chains', () => {
    const proposal = makeProposal({
      requiredNamespaces: {
        algorand: { chains: [], methods: [], events: [] },
      },
    });
    expect(areRequiredChainsSupported(proposal)).toBe(true);
  });
});

// ===========================================================================
// Genesis-hash resolution (decodeGenesisHashToHex tested via public helpers)
// ===========================================================================

describe('getChainIdByGenesisHash', () => {
  it('resolves a Uint8Array genesis hash to the Voi chain id', () => {
    expect(getChainIdByGenesisHash(hexToBytes(VOI_GENESIS_HEX))).toBe(VOI);
  });

  it('resolves a standard base64 genesis hash string', () => {
    expect(getChainIdByGenesisHash(hexToBase64(VOI_GENESIS_HEX))).toBe(VOI);
  });

  it('resolves a base64url (unpadded) genesis hash string', () => {
    expect(getChainIdByGenesisHash(hexToBase64Url(ALGO_GENESIS_HEX))).toBe(
      ALGO
    );
  });

  it('resolves the Algorand mainnet Uint8Array genesis hash', () => {
    expect(getChainIdByGenesisHash(hexToBytes(ALGO_GENESIS_HEX))).toBe(ALGO);
  });

  it('returns null for an unknown genesis hash', () => {
    const unknown = hexToBytes('00'.repeat(32));
    expect(getChainIdByGenesisHash(unknown)).toBeNull();
  });

  it('returns null for malformed / wrong-length hash strings', () => {
    // Garbage that decodes to non-matching bytes must not resolve to a chain.
    expect(getChainIdByGenesisHash('not-a-real-genesis-hash!!!')).toBeNull();
    // A correctly-encoded but wrong-length (8-byte) value must not resolve.
    expect(getChainIdByGenesisHash(hexToBase64('deadbeefdeadbeef'))).toBeNull();
    expect(getChainIdByGenesisHash(hexToBytes('deadbeef'))).toBeNull();
  });

  it('returns null for null / undefined / empty input', () => {
    expect(getChainIdByGenesisHash(null)).toBeNull();
    expect(getChainIdByGenesisHash(undefined)).toBeNull();
    expect(getChainIdByGenesisHash('')).toBeNull();
  });
});

describe('getNetworkByGenesisHash', () => {
  it('resolves Voi and Algorand networks from Uint8Array hashes', () => {
    expect(getNetworkByGenesisHash(hexToBytes(VOI_GENESIS_HEX))).toBe(
      NetworkId.VOI_MAINNET
    );
    expect(getNetworkByGenesisHash(hexToBytes(ALGO_GENESIS_HEX))).toBe(
      NetworkId.ALGORAND_MAINNET
    );
  });

  it('resolves from base64 string hashes', () => {
    expect(getNetworkByGenesisHash(hexToBase64(VOI_GENESIS_HEX))).toBe(
      NetworkId.VOI_MAINNET
    );
  });

  it('returns null for an unknown or empty genesis hash', () => {
    expect(getNetworkByGenesisHash(hexToBytes('11'.repeat(32)))).toBeNull();
    expect(getNetworkByGenesisHash(null)).toBeNull();
    expect(getNetworkByGenesisHash('')).toBeNull();
  });

  it('returns null for malformed / wrong-length hash strings', () => {
    expect(getNetworkByGenesisHash('not-a-real-genesis-hash!!!')).toBeNull();
    expect(getNetworkByGenesisHash(hexToBase64('deadbeefdeadbeef'))).toBeNull();
  });
});

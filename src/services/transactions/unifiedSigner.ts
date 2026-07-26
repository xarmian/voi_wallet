import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import { TransactionService, TransactionParams } from '@/services/transactions';
import type { WalletTransaction } from '@/services/walletconnect/types';
import {
  WalletAccount,
  AccountMetadata,
  AccountType,
  LedgerAccountError,
  LedgerDeviceNotConnectedError,
  LedgerAppNotOpenError,
  LedgerUserRejectedError,
  RemoteSignerRequiredError,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import { SecureKeyManager } from '@/services/secure/keyManager';

/**
 * Error thrown when attempting to sign with a remote signer account directly.
 *
 * TASK-41: the canonical declaration now lives in `@/types/wallet` — it was
 * previously declared here AND in `remoteSigner/signingRouter.ts` with
 * incompatible constructors, so cross-module `instanceof` checks could fail.
 * Re-exported so existing import paths keep working.
 */
export { RemoteSignerRequiredError };

/**
 * Genesis hash (lowercase hex) -> NetworkId, derived from the single source of
 * truth in `NETWORK_CONFIGURATIONS` rather than a second hand-maintained table.
 * Used by the DR-7 sign-time chain binding below.
 */
const GENESIS_HASH_HEX_TO_NETWORK: ReadonlyMap<string, NetworkId> = new Map(
  (
    Object.values(NETWORK_CONFIGURATIONS) as {
      id: NetworkId;
      genesisHash: string;
    }[]
  ).map(
    (config) =>
      [
        Buffer.from(config.genesisHash, 'base64').toString('hex').toLowerCase(),
        config.id,
      ] as const
  )
);

/**
 * Resolve the network a DECODED transaction belongs to from its genesis hash.
 * Returns `null` for an absent, malformed, or unsupported genesis hash — the
 * caller must treat that as a rejection, never as "assume the active network".
 */
function networkFromGenesisHash(
  genesisHash: Uint8Array | undefined
): NetworkId | null {
  if (!genesisHash || genesisHash.length === 0) {
    return null;
  }
  const hex = Buffer.from(genesisHash).toString('hex').toLowerCase();
  return GENESIS_HASH_HEX_TO_NETWORK.get(hex) ?? null;
}

/**
 * DR-5 / DR-7 / DR-14 — the WalletConnect session an incoming dApp batch is
 * bound to.
 *
 * Resolved once at the request boundary (`TransactionRequestScreen`) and
 * threaded through navigation to the signer, which re-checks EVERY entry
 * against it before a key is touched. Authorization is chain-scoped (DR-14): a
 * session may approve address A on Voi but not on Algorand, so membership is
 * tested on the full CAIP-10 string, never on the bare address.
 */
export interface WalletConnectSessionBinding {
  /** Session topic the request arrived on. */
  topic: string;
  /** CAIP-2 chain the request is scoped to, e.g. `algorand:<32-char gh>`. */
  chainId: string;
  /**
   * NetworkId resolved from `chainId` at the boundary. Threaded into
   * `SecureKeyManager.signTransaction` so rekey authority is resolved against
   * the TRANSACTION's network rather than the app's active one.
   */
  networkId: NetworkId;
  /**
   * Full CAIP-10 accounts (`algorand:<chain>:<address>`) the live session
   * approved FOR `chainId`. Never substituted with local accounts: an absent,
   * disconnected, topic-mismatched or empty set is a rejection.
   */
  approvedAccounts: string[];
}

/**
 * Preflight decision for one batch entry, computed BEFORE any key is touched.
 *  - `sign`        — eligible; hand the decoded txn to SecureKeyManager.
 *  - `decline`     — ARC-0001 says return `null` in this slot (DR-1).
 *  - `passthrough` — a genuine, validly-authorized pre-signed blob (DR-8/DR-16).
 */
type BatchEntryPlan =
  | { action: 'sign'; txn: algosdk.Transaction; sender: string }
  | { action: 'decline' }
  | { action: 'passthrough'; value: string };

/**
 * Unified callback interface for ALL signing operations
 */
export interface UnifiedSigningCallbacks {
  // Authentication phase
  onAuthStart?: () => void;
  onAuthSuccess?: () => void;
  onAuthError?: (error: Error) => void;

  // Signing phase
  onSigningStart?: () => void;
  onLedgerPrompt?: (ctx: { index: number; total: number }) => void;
  onLedgerSigned?: (ctx: { index: number; total: number }) => void;
  onLedgerRejected?: (ctx: {
    index: number;
    total: number;
    error: Error;
  }) => void;

  // Network phase
  onNetworkSubmit?: () => void;
  onNetworkConfirmed?: (txId: string, confirmed?: boolean) => void;
  onNetworkError?: (error: Error) => void;

  // Completion
  onComplete?: (result: UnifiedSigningResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Standard result interface for all signing operations
 */
export interface UnifiedSigningResult {
  success: boolean;
  transactionId?: string;
  transactionIds?: string[];
  /**
   * Whether the submitted transaction was confirmed within the round window.
   * `false` = submitted but still pending (NOT a failure); `undefined` = not
   * tracked on this path, treated as success by the UI for backward compat.
   */
  confirmed?: boolean;
  error?: Error;
  /**
   * DR-1 — ARC-0001 response array. For a batch, this is index-aligned with the
   * request and a `null` element means "the wallet DECLINED to sign this entry",
   * which is exactly what the standard requires. It is NOT a placeholder for the
   * unsigned bytes: returning raw unsigned bytes where a `SignedTxn` belongs is
   * the original `apaa` msgpack-decode failure this contract exists to prevent.
   * Every consumer that submits must guard the `null`s rather than submit them.
   */
  signedTransactions?: Uint8Array | Uint8Array[] | (string | null)[];
}

/**
 * Transaction types supported by the unified signer
 */
export type UnifiedTransactionType =
  | 'voi_transfer'
  | 'asa_transfer'
  | 'arc200_transfer'
  | 'arc72_transfer'
  | 'rekey'
  | 'rekey_reverse'
  | 'batch_transaction'
  | 'walletconnect_batch' // Deprecated: use batch_transaction instead
  | 'keyreg' // Key registration (go online/offline for consensus)
  | 'appl'; // Application call (smart contract interaction)

/**
 * Unified transaction request interface
 */
export interface UnifiedTransactionRequest {
  type: UnifiedTransactionType;
  /**
   * Signing account. Accepts the full `AccountMetadata` (the real runtime shape
   * passed by the in-app confirmation screens, which carries `type`/`authAddress`
   * for correct signer selection) as well as the legacy `WalletAccount` still
   * supplied by a couple of callers (AppCall/Keyreg confirm screens). The union
   * is behavior-preserving and keeps every existing caller type-safe.
   */
  account: AccountMetadata | WalletAccount;
  pin?: string;

  // For standard transfers (VOI/ASA/ARC200)
  transferParams?: TransactionParams;

  // For rekey operations
  rekeyParams?: {
    fromAddress: string;
    rekeyToAddress?: string; // undefined for reverse rekey
    note?: string;
    networkId?: NetworkId;
  };

  // For WalletConnect batch signing
  walletConnectParams?: {
    transactions: WalletTransaction[];
    /**
     * The account the user actually reviewed and consented to sign with.
     * DR-13: eligibility never outruns the UI — an entry is only signed when the
     * DECODED sender IS this account.
     */
    accountAddress: string;
    // Optional: Pre-decoded transactions to avoid double-parsing
    decodedTransactions?: algosdk.Transaction[];
    /**
     * REQUIRED, deliberately with NO default.
     *
     * `null` declares an IN-APP batch that the wallet itself built (swap /
     * claim): there is no dApp session to bind to. A value binds the batch to a
     * WalletConnect session + chain and turns on the DR-5/DR-7/DR-14 checks.
     *
     * Making it required means a caller that forgets to thread the session
     * fails to COMPILE rather than silently getting the unbound path.
     */
    sessionBinding: WalletConnectSessionBinding | null;
  };

  // For key registration (go online/offline)
  keyregParams?: {
    address: string;
    voteKey?: Uint8Array;
    selectionKey?: Uint8Array;
    stateProofKey?: Uint8Array;
    voteFirst?: number;
    voteLast?: number;
    voteKeyDilution?: number;
    nonParticipation?: boolean; // true for going offline
    fee?: number;
    note?: string;
    networkId?: NetworkId;
  };

  // For application calls
  applParams?: {
    senderAddress: string;
    appId: number;
    appArgs?: Uint8Array[];
    foreignApps?: number[];
    foreignAssets?: number[];
    accounts?: string[];
    boxes?: { appIndex: number; name: Uint8Array }[];
    fee?: number;
    note?: string;
    networkId?: NetworkId;
  };

  // Network ID for the transaction (optional, defaults to current network)
  networkId?: NetworkId;
}

/**
 * Unified Transaction Signer - Single service for ALL transaction signing
 */
export class UnifiedTransactionSigner {
  private static instance: UnifiedTransactionSigner | null = null;

  public static getInstance(): UnifiedTransactionSigner {
    if (!UnifiedTransactionSigner.instance) {
      UnifiedTransactionSigner.instance = new UnifiedTransactionSigner();
    }
    return UnifiedTransactionSigner.instance;
  }

  /**
   * Main entry point - sign any type of transaction with unified flow
   */
  async signTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    try {
      callbacks?.onAuthStart?.();

      // Validate request
      this.validateRequest(request);

      callbacks?.onAuthSuccess?.();
      callbacks?.onSigningStart?.();

      // Route to appropriate signing method based on type
      let result: UnifiedSigningResult;

      switch (request.type) {
        case 'voi_transfer':
        case 'asa_transfer':
        case 'arc200_transfer':
        case 'arc72_transfer':
          result = await this.signStandardTransfer(request, callbacks);
          break;

        case 'rekey':
        case 'rekey_reverse':
          result = await this.signRekeyTransaction(request, callbacks);
          break;

        case 'batch_transaction':
        case 'walletconnect_batch':
          result = await this.signWalletConnectBatch(request, callbacks);
          break;

        case 'keyreg':
          result = await this.signKeyregTransaction(request, callbacks);
          break;

        case 'appl':
          result = await this.signApplTransaction(request, callbacks);
          break;

        default:
          throw new Error(`Unsupported transaction type: ${request.type}`);
      }

      callbacks?.onComplete?.(result);
      return result;
    } catch (error) {
      const errorObj =
        error instanceof Error ? error : new Error(String(error));
      const failResult: UnifiedSigningResult = {
        success: false,
        error: errorObj,
      };

      callbacks?.onError?.(errorObj);
      callbacks?.onComplete?.(failResult);

      return failResult;
    }
  }

  /**
   * Sign standard transfers (VOI, ASA, ARC200)
   */
  private async signStandardTransfer(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.transferParams) {
      throw new Error('Transfer parameters required for standard transfers');
    }

    try {
      // Use existing TransactionService with unified callbacks
      const { txId, confirmed } = await TransactionService.sendTransaction(
        request.transferParams,
        request.account,
        request.pin,
        {
          onLedgerPrompt: callbacks?.onLedgerPrompt,
          onLedgerSigned: callbacks?.onLedgerSigned,
          onLedgerRejected: callbacks?.onLedgerRejected,
          onNetworkSubmit: callbacks?.onNetworkSubmit,
          onNetworkConfirmed: callbacks?.onNetworkConfirmed,
        }
      );

      return {
        success: true,
        transactionId: txId,
        confirmed,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Sign rekey transactions (rekey or reverse rekey) using unified signing flow
   */
  private async signRekeyTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.rekeyParams) {
      throw new Error('Rekey parameters required for rekey transactions');
    }

    try {
      let txId: string;
      let confirmed: boolean;

      if (request.type === 'rekey_reverse') {
        // Reverse rekey - return authority to original account
        ({ txId, confirmed } =
          await TransactionService.sendRekeyReverseTransaction(
            {
              fromAddress: request.rekeyParams.fromAddress,
              note: request.rekeyParams.note,
              networkId: request.rekeyParams.networkId || request.networkId,
            },
            { address: request.account.address },
            request.pin,
            {
              onLedgerPrompt: callbacks?.onLedgerPrompt,
              onLedgerSigned: callbacks?.onLedgerSigned,
              onLedgerRejected: callbacks?.onLedgerRejected,
              onNetworkSubmit: callbacks?.onNetworkSubmit,
              onNetworkConfirmed: callbacks?.onNetworkConfirmed,
            }
          ));
      } else {
        // Standard rekey to another account
        if (!request.rekeyParams.rekeyToAddress) {
          throw new Error('Target rekey address required for rekey operation');
        }

        ({ txId, confirmed } = await TransactionService.sendRekeyTransaction(
          {
            fromAddress: request.rekeyParams.fromAddress,
            rekeyToAddress: request.rekeyParams.rekeyToAddress,
            note: request.rekeyParams.note,
            networkId: request.rekeyParams.networkId || request.networkId,
          },
          { address: request.account.address },
          request.pin,
          {
            onLedgerPrompt: callbacks?.onLedgerPrompt,
            onLedgerSigned: callbacks?.onLedgerSigned,
            onLedgerRejected: callbacks?.onLedgerRejected,
            onNetworkSubmit: callbacks?.onNetworkSubmit,
            onNetworkConfirmed: callbacks?.onNetworkConfirmed,
          }
        ));
      }

      return {
        success: true,
        transactionId: txId,
        confirmed,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Sign WalletConnect batch transactions
   */
  private async signWalletConnectBatch(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.walletConnectParams) {
      throw new Error('WalletConnect parameters required for batch signing');
    }

    const params = request.walletConnectParams;

    try {
      const total = params.transactions.length;
      const binding = params.sessionBinding;

      // The network the batch is bound to. For a dApp request this is resolved
      // from the SESSION's chain; for an in-app batch it is the network the
      // caller built the group on. Threaded into SecureKeyManager so rekey
      // authority is resolved on the transaction's chain, not the active one.
      const boundNetworkId = binding?.networkId ?? request.networkId;

      // DR-5/DR-14 fail-closed guard: an absent / disconnected / topic-
      // mismatched session resolves to an EMPTY approved set. Reject the whole
      // request rather than silently declining every entry — and never
      // substitute the wallet's local accounts for the session's.
      const effectiveBinding = binding
        ? {
            ...binding,
            approvedAccounts: await this.revalidateBinding(binding),
          }
        : null;

      // ---------------------------------------------------------------------
      // PREFLIGHT (DR-2/5/7/8/13/14/16). Runs to completion BEFORE a single key
      // is touched, so one bad entry fails the WHOLE batch with no partial
      // signatures and no partially-signed response handed back to a dApp.
      // ---------------------------------------------------------------------
      const plans = params.transactions.map((wtxn, index) =>
        this.planBatchEntry(
          wtxn,
          index,
          params,
          effectiveBinding,
          boundNetworkId
        )
      );

      // Track signing progress for each transaction. `null` = declined (DR-1).
      const signedTxns: (string | null)[] = [];

      // Detect if this is a Ledger account - Ledger requires sequential signing due to hardware constraints
      const isLedgerAccount = request.account.type === AccountType.LEDGER;

      // For Ledger accounts: sign sequentially (hardware constraint)
      // For standard accounts: sign in parallel for better performance
      if (isLedgerAccount) {
        // Sequential signing for Ledger
        for (let i = 0; i < plans.length; i++) {
          callbacks?.onLedgerPrompt?.({ index: i + 1, total });

          const plan = plans[i];

          if (plan.action !== 'sign') {
            // Declined -> ARC-0001 `null`; genuine pre-signed -> verbatim.
            signedTxns.push(plan.action === 'passthrough' ? plan.value : null);
            callbacks?.onLedgerSigned?.({ index: i + 1, total });
            continue;
          }

          try {
            // Sign with the SENDER's key. The dApp-supplied `authAddr`/`signers`
            // are advisory hints for ELIGIBILITY only — never key selection: a
            // dApp must not be able to direct which of our keys signs, and rekey
            // authority is resolved from on-chain state, not from the request
            // (TASK-163). SecureKeyManager.signTransaction(txn, sender)
            // resolves any current rekey authority itself and signs with it
            // (emitting the correct sgnr) — identical to the non-rekeyed path.
            const signedTxnBlob = await SecureKeyManager.signTransaction(
              plan.txn,
              plan.sender,
              request.pin, // optional; controller supplies for software keys, undefined for Ledger
              boundNetworkId
            );

            signedTxns.push(Buffer.from(signedTxnBlob).toString('base64'));
            callbacks?.onLedgerSigned?.({ index: i + 1, total });
          } catch (error) {
            const sanitizedError = this.sanitizeBLEError(error);
            callbacks?.onLedgerRejected?.({
              index: i + 1,
              total,
              error: sanitizedError,
            });
            throw sanitizedError;
          }
        }
      } else {
        // Parallel signing for standard accounts (much faster!)
        callbacks?.onLedgerPrompt?.({ index: 1, total });

        const signingPromises = plans.map(
          async (plan, i): Promise<string | null> => {
            if (plan.action !== 'sign') {
              return plan.action === 'passthrough' ? plan.value : null;
            }

            try {
              // See the TASK-163 note on the Ledger branch above: the SENDER is
              // always the address handed to SecureKeyManager.
              const signedTxnBlob = await SecureKeyManager.signTransaction(
                plan.txn,
                plan.sender,
                request.pin,
                boundNetworkId
              );

              return Buffer.from(signedTxnBlob).toString('base64');
            } catch (error) {
              const sanitizedError = this.sanitizeBLEError(error);
              callbacks?.onLedgerRejected?.({
                index: i + 1,
                total,
                error: sanitizedError,
              });
              throw sanitizedError;
            }
          }
        );

        // Sign all transactions in parallel
        const results = await Promise.all(signingPromises);

        signedTxns.push(...results);

        // Report completion after all parallel signing is done
        callbacks?.onLedgerSigned?.({ index: total, total });
      }

      // Clear private key cache for security (cache is inside AccountSecureStorage)
      // Note: Cache auto-expires after 60s, but we clear immediately for security
      const { AccountSecureStorage } = await import(
        '@/services/secure/AccountSecureStorage'
      );
      AccountSecureStorage.clearPrivateKeyCache();

      // All transactions signed successfully
      callbacks?.onNetworkSubmit?.();

      return {
        success: true,
        signedTransactions: signedTxns,
      };
    } catch (error) {
      // Clear private key cache on error too for security
      const { AccountSecureStorage } = await import(
        '@/services/secure/AccountSecureStorage'
      );
      AccountSecureStorage.clearPrivateKeyCache();
      throw error;
    }
  }

  /**
   * DR-5 — re-resolve the session's approved accounts against the LIVE session,
   * immediately before preflight.
   *
   * The binding is snapshotted when the request screen loads, but the user then
   * reviews the group and authenticates, which can take minutes. In that window
   * the session can be disconnected, expire, or drop an account via
   * `session_update`. Trusting the snapshot would let the wallet sign against
   * authorization the dApp no longer holds.
   *
   * The result is the INTERSECTION of the snapshot and the live set, so it can
   * only ever shrink: an account the session gained after the review started was
   * never reviewed and must not become signable here either. An empty
   * intersection is a rejection of the whole request.
   */
  private async revalidateBinding(
    binding: WalletConnectSessionBinding
  ): Promise<string[]> {
    // Lazy import: keeps the in-app batch path free of the WalletConnect module
    // graph, and mirrors the existing dynamic-import pattern in this file.
    const { WalletConnectService } = await import('@/services/walletconnect');
    const service = WalletConnectService.getInstance();

    const live = service.getApprovedAccountsForChain(
      binding.topic,
      binding.chainId
    );

    const stillApproved = binding.approvedAccounts.filter((caipAccount) =>
      live.includes(caipAccount)
    );

    if (stillApproved.length === 0) {
      throw new Error(
        'This dApp session no longer approves an account on the requested ' +
          'network. Reconnect the session and try again.'
      );
    }

    return stillApproved;
  }

  /**
   * Preflight ONE batch entry. Never touches a key; either returns a plan or
   * THROWS, and a throw fails the entire batch (DR-7/DR-8).
   */
  private planBatchEntry(
    wtxn: WalletTransaction,
    index: number,
    params: NonNullable<UnifiedTransactionRequest['walletConnectParams']>,
    binding: WalletConnectSessionBinding | null,
    boundNetworkId: NetworkId | undefined
  ): BatchEntryPlan {
    const txnBytes = Buffer.from(wtxn.txn, 'base64');

    // Reuse the caller's pre-decoded transactions ONLY when the cached entry
    // re-encodes to exactly the wire bytes of this entry. The cache is a
    // display-side optimization; an index-alignment check alone would let a
    // caller show one transaction and get a different one signed, so the bytes
    // that were reviewed and the object that gets signed are proven identical.
    const cache = params.decodedTransactions;
    let txn: algosdk.Transaction | null = null;

    if (cache && cache.length === params.transactions.length && cache[index]) {
      try {
        const reEncoded = Buffer.from(
          algosdk.encodeUnsignedTransaction(cache[index])
        );
        if (reEncoded.equals(txnBytes)) {
          txn = cache[index];
        }
      } catch {
        txn = null;
      }
    }

    if (!txn) {
      try {
        txn = algosdk.decodeUnsignedTransaction(txnBytes);
      } catch {
        txn = null;
      }
    }

    if (!txn || !txn.sender || !txn.sender.publicKey) {
      // Not a decodable unsigned transaction. DR-8/DR-16: ONLY a genuine,
      // validly-authorized pre-signed blob passes through unchanged. Malformed
      // bytes are rejected, never echoed back to the dApp.
      this.assertGenuinePreSigned(txnBytes, index, binding, boundNetworkId);
      return { action: 'passthrough', value: wtxn.txn };
    }

    // DR-7 (absorbs TASK-251): bind the bytes to a chain before anything else.
    this.assertChainBinding(txn, index, binding, boundNetworkId);

    const txnSender = algosdk.encodeAddress(txn.sender.publicKey);

    if (
      !this.isEligibleBatchEntry(
        txnSender,
        params.accountAddress,
        wtxn,
        binding
      )
    ) {
      return { action: 'decline' };
    }

    return { action: 'sign', txn, sender: txnSender };
  }

  /**
   * DR-7 / TASK-251 — sign-time chain binding.
   *
   * Nothing between "a dApp handed us bytes" and `SecureKeyManager` used to
   * establish which chain those bytes were for. This asserts that the decoded
   * transaction's own genesis identity matches the network the batch is bound
   * to. An unmapped or absent genesis hash is a rejection, never a default to
   * the app's active network. One mismatched entry fails the WHOLE batch: a
   * partially-signed group returned to a dApp is its own failure mode.
   *
   * For an in-app batch with no declared network there is nothing to bind to
   * (the wallet built the group itself), so the check is skipped.
   */
  private assertChainBinding(
    txn: algosdk.Transaction,
    index: number,
    binding: WalletConnectSessionBinding | null,
    boundNetworkId: NetworkId | undefined
  ): void {
    if (!boundNetworkId) {
      return;
    }

    const expected = NETWORK_CONFIGURATIONS[boundNetworkId];
    if (!expected) {
      throw new Error(
        'Mixed or invalid network batch: this request targets a network this wallet does not support.'
      );
    }

    if (binding && expected.chainId !== binding.chainId) {
      // Defence in depth: the boundary is supposed to derive networkId FROM
      // chainId, so a disagreement means the handoff was tampered with.
      throw new Error(
        'Mixed or invalid network batch: the session chain and resolved network disagree.'
      );
    }

    const actual = networkFromGenesisHash(txn.genesisHash);
    if (!actual) {
      throw new Error(
        `Mixed or invalid network batch: transaction ${index + 1} carries no recognized network identity.`
      );
    }
    if (actual !== boundNetworkId) {
      throw new Error(
        `Mixed or invalid network batch: transaction ${index + 1} is for ` +
          `${NETWORK_CONFIGURATIONS[actual].name}, but this request is for ${expected.name}.`
      );
    }
    if (txn.genesisID && txn.genesisID !== expected.genesisId) {
      throw new Error(
        `Mixed or invalid network batch: transaction ${index + 1} declares genesis ID ` +
          `"${txn.genesisID}", which is not ${expected.name}.`
      );
    }
  }

  /**
   * DR-8 / DR-16 — classify before pass-through.
   *
   * `decodeSignedTransaction` only proves a msgpack wrapper parsed; it does not
   * prove a usable authorization exists. Require exactly one authorization form
   * and, for dApp-supplied bytes, verify it cryptographically against
   * `sgnr ?? sender`. Anything else is REJECTED rather than echoed back — an
   * echoed blob is submitted by the dApp and fails at algod, which is precisely
   * the class of bug this change exists to remove.
   *
   * The cryptographic verification is applied to SESSION-BOUND (dApp) bytes.
   * An in-app batch (swap / claim) gets the structural check only: those groups
   * are assembled by our own aggregator integrations and may legitimately carry
   * delegated logic-sigs that `LogicSig.verify` cannot validate offline (it does
   * not track the delegating public key when the sender differs).
   */
  private assertGenuinePreSigned(
    txnBytes: Uint8Array,
    index: number,
    binding: WalletConnectSessionBinding | null,
    boundNetworkId: NetworkId | undefined
  ): void {
    let stxn: algosdk.SignedTransaction;
    try {
      stxn = algosdk.decodeSignedTransaction(txnBytes);
    } catch {
      throw new Error(
        `Transaction ${index + 1} is neither a valid unsigned transaction nor a valid signed transaction.`
      );
    }

    // A pre-signed group member is still part of THIS request's chain.
    this.assertChainBinding(stxn.txn, index, binding, boundNetworkId);

    const forms = [stxn.sig, stxn.msig, stxn.lsig].filter(Boolean).length;
    if (forms !== 1) {
      throw new Error(
        `Transaction ${index + 1} claims to be pre-signed but carries no single valid authorization.`
      );
    }

    if (!binding) {
      return;
    }

    const authorizer = stxn.sgnr ?? stxn.txn.sender;
    let authorized: boolean;
    try {
      if (stxn.lsig) {
        authorized = stxn.lsig.verify(authorizer.publicKey);
      } else if (stxn.msig) {
        authorized = algosdk.verifyMultisig(
          stxn.txn.bytesToSign(),
          stxn.msig,
          authorizer.publicKey
        );
      } else {
        authorized = nacl.sign.detached.verify(
          stxn.txn.bytesToSign(),
          stxn.sig!,
          authorizer.publicKey
        );
      }
    } catch {
      authorized = false;
    }

    if (!authorized) {
      throw new Error(
        `Transaction ${index + 1} claims to be pre-signed but its signature does not verify.`
      );
    }
  }

  /**
   * Decide whether a WalletConnect batch entry should be signed by this wallet.
   *
   * The signing KEY is always the transaction sender's — SecureKeyManager
   * resolves any on-chain rekey authority itself. This gates ELIGIBILITY only,
   * from the DECODED sender plus the session's approved accounts and the dApp's
   * advisory `signers` hint; it never lets request metadata (`authAddr` /
   * `signers`) select which key signs (TASK-163).
   *
   * Evaluated in order, all must pass (DR-2 / DR-5 / DR-13 / DR-14):
   *  1. the sender is authorized by the SESSION for THIS chain. Membership is
   *     tested on the full CAIP-10 string, so a Voi-only approval for A cannot
   *     authorize an Algorand transaction from A.
   *  2. `signers: []` is an explicit do-not-sign instruction — never signed.
   *  3. a non-empty `signers` must designate this entry as ours. ARC-0001
   *     encodes a REKEYED sender as `signers: [authAddr]`, so the entry's own
   *     advisory `authAddr` also satisfies the designation. That stays advisory:
   *     the key still comes from the sender via on-chain rekey resolution.
   *  4. DR-13 — the sender must be the account the user actually reviewed. The
   *     review screen can only name ONE account, so signing on behalf of any
   *     other approved account would mean "UI says A, signs B". Widening to true
   *     multi-account signing lands with the signer-list UI (TASK-259).
   */
  private isEligibleBatchEntry(
    txnSender: string,
    reviewedAccount: string,
    wtxn: WalletTransaction,
    binding: WalletConnectSessionBinding | null
  ): boolean {
    // 1. Session authorization, chain-scoped (DR-5 / DR-14).
    if (binding) {
      const caipAccount = `${binding.chainId}:${txnSender}`;
      if (!binding.approvedAccounts.includes(caipAccount)) {
        return false;
      }
    }

    // 2/3. ARC-0001 `signers` semantics (DR-2).
    if (Array.isArray(wtxn.signers)) {
      if (wtxn.signers.length === 0) {
        return false;
      }
      const designatesSender =
        wtxn.signers.includes(txnSender) ||
        (!!wtxn.authAddr && wtxn.signers.includes(wtxn.authAddr));
      if (!designatesSender) {
        return false;
      }
    }

    // 4. The reviewed account, and only the reviewed account (DR-13).
    return txnSender === reviewedAccount;
  }

  /**
   * Validate the unified transaction request
   */
  private validateRequest(request: UnifiedTransactionRequest): void {
    if (!request.account) {
      throw new Error('Account is required');
    }

    if (!request.type) {
      throw new Error('Transaction type is required');
    }

    // Check for REMOTE_SIGNER accounts - these cannot be signed directly
    if (request.account.type === AccountType.REMOTE_SIGNER) {
      throw new RemoteSignerRequiredError({
        accountAddress: request.account.address,
        message:
          'This account uses remote signing via QR codes. ' +
          'Please use the remote signer flow instead of direct signing.',
      });
    }

    // Check for WATCH accounts - these cannot sign at all
    if (request.account.type === AccountType.WATCH) {
      throw new Error('Watch accounts cannot sign transactions');
    }

    // Type-specific validation
    switch (request.type) {
      case 'voi_transfer':
      case 'asa_transfer':
      case 'arc200_transfer':
      case 'arc72_transfer':
        if (!request.transferParams) {
          throw new Error(
            'Transfer parameters required for transfer transactions'
          );
        }
        break;

      case 'rekey':
      case 'rekey_reverse':
        if (!request.rekeyParams) {
          throw new Error('Rekey parameters required for rekey transactions');
        }
        if (request.type === 'rekey' && !request.rekeyParams.rekeyToAddress) {
          throw new Error('Target rekey address required for standard rekey');
        }
        break;

      case 'batch_transaction':
      case 'walletconnect_batch':
        if (!request.walletConnectParams) {
          throw new Error('Batch parameters required for batch signing');
        }
        break;

      case 'keyreg':
        if (!request.keyregParams) {
          throw new Error(
            'Keyreg parameters required for key registration transactions'
          );
        }
        break;

      case 'appl':
        if (!request.applParams) {
          throw new Error(
            'Application parameters required for app call transactions'
          );
        }
        if (!request.applParams.appId) {
          throw new Error('Application ID required for app call transactions');
        }
        break;
    }
  }

  /**
   * Estimate transaction cost for any transaction type
   */
  async estimateTransactionCost(request: UnifiedTransactionRequest): Promise<{
    fee: number;
    total: number | bigint;
  }> {
    switch (request.type) {
      case 'voi_transfer':
      case 'asa_transfer':
      case 'arc200_transfer':
      case 'arc72_transfer':
        if (!request.transferParams) {
          throw new Error('Transfer parameters required');
        }
        return await TransactionService.estimateTransactionCost(
          request.transferParams
        );

      case 'rekey':
      case 'rekey_reverse':
        // Rekey transactions have minimal cost (just network fee)
        const fee = 1000; // Standard Algorand fee in microAlgos
        return { fee, total: fee };

      case 'batch_transaction':
      case 'walletconnect_batch':
        if (!request.walletConnectParams) {
          throw new Error('Batch parameters required');
        }
        // Estimate based on number of transactions
        const transactionCount =
          request.walletConnectParams.transactions.length;
        const batchFee = 1000 * transactionCount; // Base fee per transaction
        return { fee: batchFee, total: batchFee };

      default:
        throw new Error(
          `Cost estimation not supported for transaction type: ${request.type}`
        );
    }
  }

  /**
   * Validate transaction before signing (without PIN)
   */
  async validateTransaction(
    request: UnifiedTransactionRequest
  ): Promise<string[]> {
    const errors: string[] = [];

    try {
      this.validateRequest(request);

      // Type-specific validation
      switch (request.type) {
        case 'voi_transfer':
        case 'asa_transfer':
        case 'arc200_transfer':
        case 'arc72_transfer':
          if (request.transferParams) {
            const validationErrors =
              await TransactionService.validateTransaction(
                request.transferParams,
                request.account
              );
            errors.push(...validationErrors);
          }
          break;

        case 'rekey':
          if (request.rekeyParams && request.rekeyParams.rekeyToAddress) {
            // We would need to pass wallet instance for full validation
            // For now, just basic validation
            if (
              request.rekeyParams.fromAddress ===
              request.rekeyParams.rekeyToAddress
            ) {
              errors.push('Cannot rekey an account to itself');
            }
          }
          break;

        case 'rekey_reverse':
          // Basic validation for reverse rekey
          break;

        case 'batch_transaction':
        case 'walletconnect_batch':
          if (request.walletConnectParams) {
            if (request.walletConnectParams.transactions.length === 0) {
              errors.push('No transactions to sign');
            }
          }
          break;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return errors;
  }

  /**
   * Sign key registration transaction (go online/offline)
   */
  private async signKeyregTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.keyregParams) {
      throw new Error('Keyreg parameters required');
    }

    try {
      const networkId = request.keyregParams.networkId || request.networkId;
      const { NetworkService } = await import('@/services/network');
      const networkService = NetworkService.getInstance(networkId);
      const suggestedParams = await networkService.getSuggestedParams();

      // Override fee if specified
      if (request.keyregParams.fee) {
        suggestedParams.fee = request.keyregParams.fee;
        suggestedParams.flatFee = true;
      }

      // Build keyreg transaction
      let txn: algosdk.Transaction;

      if (request.keyregParams.nonParticipation) {
        // Go offline (non-participation)
        txn = algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
          sender: request.keyregParams.address,
          suggestedParams,
          nonParticipation: true,
          note: request.keyregParams.note
            ? new Uint8Array(Buffer.from(request.keyregParams.note))
            : undefined,
        });
      } else {
        // Go online with participation keys
        txn = algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
          sender: request.keyregParams.address,
          voteKey: request.keyregParams.voteKey,
          selectionKey: request.keyregParams.selectionKey,
          stateProofKey: request.keyregParams.stateProofKey,
          voteFirst: request.keyregParams.voteFirst,
          voteLast: request.keyregParams.voteLast,
          voteKeyDilution: request.keyregParams.voteKeyDilution,
          suggestedParams,
          note: request.keyregParams.note
            ? new Uint8Array(Buffer.from(request.keyregParams.note))
            : undefined,
        });
      }

      callbacks?.onLedgerPrompt?.({ index: 1, total: 1 });

      // Sign the transaction
      const signedTxnBlob = await SecureKeyManager.signTransaction(
        txn,
        request.keyregParams.address,
        request.pin
      );

      callbacks?.onLedgerSigned?.({ index: 1, total: 1 });
      callbacks?.onNetworkSubmit?.();

      // Submit to network
      const txId = await networkService.sendRawTransaction(signedTxnBlob);

      // Wait for confirmation
      await networkService.waitForConfirmation(txId);

      callbacks?.onNetworkConfirmed?.(txId);

      return {
        success: true,
        transactionId: txId,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Sign application call transaction
   */
  private async signApplTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.applParams) {
      throw new Error('Application parameters required');
    }

    try {
      const networkId = request.applParams.networkId || request.networkId;
      const { NetworkService } = await import('@/services/network');
      const networkService = NetworkService.getInstance(networkId);
      const suggestedParams = await networkService.getSuggestedParams();

      // Override fee if specified
      if (request.applParams.fee) {
        suggestedParams.fee = request.applParams.fee;
        suggestedParams.flatFee = true;
      }

      // Build application call transaction
      const txn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: request.applParams.senderAddress,
        appIndex: request.applParams.appId,
        appArgs: request.applParams.appArgs,
        foreignApps: request.applParams.foreignApps,
        foreignAssets: request.applParams.foreignAssets,
        accounts: request.applParams.accounts,
        boxes: request.applParams.boxes,
        suggestedParams,
        note: request.applParams.note
          ? new Uint8Array(Buffer.from(request.applParams.note))
          : undefined,
      });

      callbacks?.onLedgerPrompt?.({ index: 1, total: 1 });

      // Sign the transaction
      const signedTxnBlob = await SecureKeyManager.signTransaction(
        txn,
        request.applParams.senderAddress,
        request.pin
      );

      callbacks?.onLedgerSigned?.({ index: 1, total: 1 });
      callbacks?.onNetworkSubmit?.();

      // Submit to network
      const txId = await networkService.sendRawTransaction(signedTxnBlob);

      // Wait for confirmation
      await networkService.waitForConfirmation(txId);

      callbacks?.onNetworkConfirmed?.(txId);

      return {
        success: true,
        transactionId: txId,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Sanitize BLE/Ledger related errors to stable, user-friendly Error objects
   */
  private sanitizeBLEError(error: unknown): Error {
    if (!error) {
      return new Error('Unknown signing error occurred');
    }

    if (typeof error === 'string') {
      return new Error(error || 'Signing failed');
    }

    if (error instanceof LedgerDeviceNotConnectedError) {
      return new LedgerDeviceNotConnectedError(
        'Ledger device not connected. Please connect your device and try again.'
      );
    }

    if (error instanceof LedgerAppNotOpenError) {
      return new LedgerAppNotOpenError(
        'Please open the Algorand app on your Ledger device.'
      );
    }

    if (error instanceof LedgerUserRejectedError) {
      return error;
    }

    if (error instanceof LedgerAccountError) {
      return error;
    }

    if (error instanceof Error) {
      const message = error.message || 'Signing failed';
      const lower = message.toLowerCase();

      if (lower.includes('timeout')) {
        return new Error(
          'Connection timeout. Please ensure your Ledger device is unlocked and the Algorand app is open.'
        );
      }
      if (lower.includes('ble')) {
        return new Error(
          'Bluetooth connection failed. Please ensure your Ledger device is connected and unlocked.'
        );
      }
      if (lower.includes('not connected') || lower.includes('not found')) {
        return new LedgerDeviceNotConnectedError(
          'Ledger device not connected. Please connect your device and try again.'
        );
      }

      return new Error(message);
    }

    try {
      return new Error(JSON.stringify(error));
    } catch {
      return new Error('Signing failed');
    }
  }
}

// Export singleton instance
export const unifiedSigner = UnifiedTransactionSigner.getInstance();

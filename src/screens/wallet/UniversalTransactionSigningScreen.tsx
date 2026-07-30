import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import algosdk from 'algosdk';

import { RootStackParamList } from '@/navigation/AppNavigator';
import { AccountMetadata, AssetParams } from '@/types/wallet';
import { NetworkId, NetworkConfiguration } from '@/types/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import { NetworkService } from '@/services/network';
import { MultiAccountWalletService } from '@/services/wallet';
import { SecureKeyManager } from '@/services/secure/keyManager';
import UniversalHeader from '@/components/common/UniversalHeader';
import UnifiedTransactionAuthModal from '@/components/UnifiedTransactionAuthModal';
import { useTransactionAuthController } from '@/services/auth/transactionAuthController';
import { UnifiedTransactionRequest } from '@/services/transactions/unifiedSigner';
import {
  evaluateBatchEntryEligibility,
  describeDeclineReason,
} from '@/services/transactions/batchEligibility';
import {
  truncateAddress,
  getNetworkByChainId,
} from '@/services/walletconnect/utils';
import { formatBaseUnitsToAmount } from '@/utils/bigint';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import TransactionDangerBanner from '@/components/transaction/TransactionDangerBanner';
import {
  detectTransactionDangers,
  aggregateDangers,
  hasAnyDanger,
  TransactionDangers,
} from '@/utils/transactionDangers';
import {
  getNavigationCallbacks,
  clearNavigationCallbacks,
} from '@/services/navigation/callbackRegistry';

type UniversalTransactionSigningScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'UniversalTransactionSigning'
>;
type UniversalTransactionSigningScreenRouteProp = RouteProp<
  RootStackParamList,
  'UniversalTransactionSigning'
>;

interface Props {
  navigation: UniversalTransactionSigningScreenNavigationProp;
  route: UniversalTransactionSigningScreenRouteProp;
}

/**
 * One decoded batch entry, as displayed.
 *
 * DR-6 — amounts, fees and asset indexes stay `bigint` end to end. algosdk v3
 * carries them as uint64, so a `Number()` narrowing anywhere on this screen
 * could show a different value than the bytes being signed.
 */
interface ParsedTransaction {
  /** Decoded sender, or `null` when the entry is not a decodable unsigned txn. */
  from: string | null;
  to: string;
  amount?: bigint;
  fee: bigint;
  note?: string;
  /** ASA index from the type-specific field; `undefined` means native currency. */
  assetId?: bigint;
  type: string;
  dangers?: TransactionDangers;
}

/** How a single account will produce its signature, resolved on chain. */
type SignerResolution =
  | {
      status: 'signable';
      account: AccountMetadata;
      method: 'software' | 'ledger';
      /** Address whose key actually signs (differs when rekeyed). */
      signingAddress: string;
      /** On-chain rekey authority, when the account is rekeyed. */
      rekeyedTo?: string;
    }
  | { status: 'unavailable'; reason: string };

/** Per-entry signer decision, index-aligned with `parsedTransactions`. */
type EntrySigner =
  | { kind: 'pending' }
  | {
      kind: 'sign';
      address: string;
      resolution: Extract<SignerResolution, { status: 'signable' }>;
    }
  | { kind: 'declined'; address: string | null; reason: string };

/**
 * Auth flows are single-identity: `UnifiedTransactionAuthModal` resolves ONE
 * strategy (PIN / biometric / a specific Ledger device) for the whole request.
 * Software keys share the wallet PIN, so any number of software accounts can be
 * served by one pass; a hardware device cannot be mixed with anything else.
 */
type AuthClass = string;

function authClassOf(
  resolution: Extract<SignerResolution, { status: 'signable' }>
): AuthClass {
  return resolution.method === 'software'
    ? 'software'
    : `device:${resolution.signingAddress}`;
}

/**
 * Strip control characters from a dApp-supplied note before display. Raw bytes
 * on a signing screen can otherwise inject newlines/escape sequences and forge
 * additional rows. Truncated so a long note cannot push the rest off screen.
 */
const NOTE_DISPLAY_LIMIT = 200;
function decodeNoteForDisplay(note: Uint8Array): string | undefined {
  if (!note || note.length === 0) {
    return undefined;
  }
  const text = Buffer.from(note)
    .toString('utf8')
    // Deliberately strips C0/C1 control characters from untrusted display text.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .trim();
  if (text.length === 0) {
    return undefined;
  }
  return text.length > NOTE_DISPLAY_LIMIT
    ? `${text.slice(0, NOTE_DISPLAY_LIMIT)}…`
    : text;
}

/**
 * Decode the batch for review.
 *
 * DR-9 — `decoded` is same-length and index-preserving: an entry that cannot be
 * decoded contributes `undefined`, never a shifted neighbour. (The signer
 * additionally re-encodes a cached entry and compares it to the wire bytes
 * before trusting it, so a mis-keyed cache can never be signed.)
 */
function parseBatch(transactionBytes: string[]): {
  parsed: ParsedTransaction[];
  decoded: (algosdk.Transaction | undefined)[];
} {
  const parsed: ParsedTransaction[] = [];
  const decoded: (algosdk.Transaction | undefined)[] = [];

  const pushUndecodable = () => {
    parsed.push({
      from: null,
      to: 'Protocol Transaction',
      fee: 0n,
      type: 'pre-signed / unreadable',
    });
    decoded.push(undefined);
  };

  for (const txnBase64 of transactionBytes) {
    try {
      const txnBytes = Buffer.from(txnBase64, 'base64');
      let txn: algosdk.Transaction;
      let isAlreadySigned = false;

      // Try to decode as unsigned first
      try {
        txn = algosdk.decodeUnsignedTransaction(txnBytes);
      } catch {
        // If that fails, try to decode as signed transaction
        try {
          const signedTxn = algosdk.decodeSignedTransaction(txnBytes);
          txn = signedTxn.txn;
          isAlreadySigned = true;
        } catch {
          // Neither worked - nothing about this entry can be displayed.
          pushUndecodable();
          continue;
        }
      }

      // Only an UNSIGNED entry is a candidate for signing, so only that one is
      // cached (and the slot stays index-aligned either way).
      decoded.push(isAlreadySigned ? undefined : txn);

      const fromAddress = txn.sender?.publicKey
        ? algosdk.encodeAddress(txn.sender.publicKey)
        : null;

      const txnType = txn.type ?? 'unknown';
      let toAddress = 'N/A';
      let amount: bigint | undefined;
      let assetId: bigint | undefined;

      if (txn.payment) {
        if (txn.payment.receiver?.publicKey) {
          toAddress = algosdk.encodeAddress(txn.payment.receiver.publicKey);
        }
        amount = txn.payment.amount ?? 0n;
      } else if (txn.assetTransfer) {
        if (txn.assetTransfer.receiver?.publicKey) {
          toAddress = algosdk.encodeAddress(
            txn.assetTransfer.receiver.publicKey
          );
        }
        amount = txn.assetTransfer.amount ?? 0n;
        // The whole point of TASK-259: in algosdk v3 the asset index lives on
        // the type-specific field, NOT on the transaction root. Reading
        // `txn.assetIndex` yielded `undefined` and the amount was then rendered
        // with the network's native symbol — "10 ALGO" for a 10 USDC transfer.
        assetId = txn.assetTransfer.assetIndex;
      } else if (txn.assetConfig) {
        assetId = txn.assetConfig.assetIndex;
        toAddress =
          assetId === 0n ? 'Asset Creation' : `Asset #${assetId.toString()}`;
      } else if (txn.assetFreeze) {
        assetId = txn.assetFreeze.assetIndex;
        toAddress = txn.assetFreeze.freezeAccount?.publicKey
          ? algosdk.encodeAddress(txn.assetFreeze.freezeAccount.publicKey)
          : 'N/A';
      } else if (txn.applicationCall) {
        const appIndex = txn.applicationCall.appIndex;
        toAddress =
          appIndex === 0n ? 'App Creation' : `App #${appIndex.toString()}`;
      }

      parsed.push({
        from: fromAddress,
        to: toAddress,
        amount,
        fee: txn.fee ?? 0n,
        note: decodeNoteForDisplay(txn.note),
        assetId,
        type: isAlreadySigned ? `${txnType} (pre-signed)` : txnType,
        // Only surface danger fields for transactions we are about to sign.
        dangers: isAlreadySigned ? undefined : detectTransactionDangers(txn),
      });
    } catch (error) {
      console.error('Failed to parse transaction:', error);
      pushUndecodable();
    }
  }

  return { parsed, decoded };
}

export default function UniversalTransactionSigningScreen({
  navigation,
  route,
}: Props) {
  const {
    transactions,
    onSuccess: directOnSuccess,
    onReject: directOnReject,
    callbackId,
    title = 'Sign Transaction',
    networkId,
    chainId,
    walletConnect,
  } = route.params;

  // DR-15 — the ARC-0001 entries are the single source of truth for a dApp
  // request: the wallet must review and sign exactly the bytes the dApp sent,
  // with its `signers`/`authAddr` intact. `transactions` (bare base64) remains
  // the shape the in-app callers (swap / claim) use.
  const walletTransactions = useMemo(
    () => walletConnect?.transactions ?? transactions.map((txn) => ({ txn })),
    [walletConnect, transactions]
  );
  const transactionBytes = useMemo(
    () => walletTransactions.map((wtxn) => wtxn.txn),
    [walletTransactions]
  );
  // The route param is typed `WalletAccount` (legacy), but callers always pass a
  // full `AccountMetadata` at runtime (see SwapScreen/Claim screens which cast the
  // other direction). Coerce to the real shape so display fields (color/label) and
  // the unified request account (which needs `type`/`authAddress` for signer
  // selection) are correctly typed. Behavior-preserving: same runtime object.
  const account = route.params.account as unknown as AccountMetadata;

  // Get callbacks from registry if callbackId provided, otherwise use direct callbacks
  const registryCallbacks = getNavigationCallbacks(callbackId);
  const onSuccess = registryCallbacks?.onSuccess || directOnSuccess;
  const onReject = registryCallbacks?.onReject || directOnReject;

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentRequest, setCurrentRequest] =
    useState<UnifiedTransactionRequest | null>(null);
  const [dangerAcknowledged, setDangerAcknowledged] = useState(false);
  /** Resolved ASA params keyed by asset id; `null` = looked up, unavailable. */
  const [assetParams, setAssetParams] = useState<
    Record<string, AssetParams | null>
  >({});
  const [signerState, setSignerState] = useState<{
    key: string;
    routes: Record<string, SignerResolution>;
    error: string | null;
  } | null>(null);
  const [signerAttempt, setSignerAttempt] = useState(0);

  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const authController = useTransactionAuthController();

  useEffect(() => {
    return () => {
      authController.cleanup();
      // Clean up callback registry when unmounting
      clearNavigationCallbacks(callbackId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once teardown: it captures authController (a stable useState(() => new TransactionAuthController()) handle) and callbackId (stable route param), so the one-per-mount teardown targets the right instance.
  }, []);

  /**
   * The network EVERY on-chain lookup on this screen resolves against, and the
   * exact value handed to the signer. Using one value for both is what keeps
   * asset metadata and rekey authority from being read on the app's ACTIVE
   * network while an Algorand request is being reviewed (DR-3): WalletConnect
   * never calls `switchNetwork`.
   */
  const boundNetworkId: NetworkId | undefined =
    walletConnect?.binding.networkId ?? networkId;

  /**
   * DR-10 / TASK-251 — an unrecognized chain is an explicit WARNING, never a
   * hidden section. A user must not be asked to approve a transaction on a
   * network this wallet cannot name.
   */
  const networkInfo = useMemo(() => {
    const config: NetworkConfiguration | undefined = boundNetworkId
      ? (
          NETWORK_CONFIGURATIONS as Partial<
            Record<NetworkId, NetworkConfiguration>
          >
        )[boundNetworkId]
      : undefined;
    const fromChain = chainId ? getNetworkByChainId(chainId) : null;
    // A chain id we cannot map, or one that disagrees with the network the
    // signer will bind to, is not something we can name honestly.
    const chainDisagrees = !!chainId && fromChain !== (boundNetworkId ?? null);

    if (!config || chainDisagrees) {
      return {
        known: false as const,
        name: chainId ?? boundNetworkId ?? 'Unidentified network',
        currency: null,
      };
    }
    return {
      known: true as const,
      name: config.name,
      currency: config.nativeToken,
    };
  }, [boundNetworkId, chainId]);

  const { parsed: parsedTransactions, decoded: decodedTransactions } = useMemo(
    () => parseBatch(transactionBytes),
    [transactionBytes]
  );

  // -------------------------------------------------------------------------
  // Asset metadata, resolved on the TRANSACTION's network (DR-3).
  // -------------------------------------------------------------------------
  const assetIdsToResolve = useMemo(() => {
    const ids = new Set<string>();
    for (const txn of parsedTransactions) {
      if (txn.assetId !== undefined && txn.assetId > 0n) {
        ids.add(txn.assetId.toString());
      }
    }
    return [...ids];
  }, [parsedTransactions]);

  useEffect(() => {
    if (!boundNetworkId || assetIdsToResolve.length === 0) {
      return;
    }
    let cancelled = false;
    const pending = assetIdsToResolve.filter((id) => !(id in assetParams));
    if (pending.length === 0) {
      return;
    }

    // `walletStore.loadAssetMetadata` is deliberately NOT used: it takes no
    // networkId and keys its cache off the ACTIVE network, which is the bug
    // this task exists to fix.
    const service = NetworkService.getInstance(boundNetworkId);
    (async () => {
      const resolved = await Promise.all(
        pending.map(async (id) => {
          const numeric = BigInt(id);
          if (numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
            // Not addressable by the numeric lookup API; render as `ASA #<id>`
            // with an exact base-unit amount rather than guessing decimals.
            return [id, null] as const;
          }
          try {
            return [
              id,
              await service.getCachedAssetParams(Number(numeric)),
            ] as const;
          } catch {
            return [id, null] as const;
          }
        })
      );
      if (cancelled) {
        return;
      }
      setAssetParams((prev) => {
        const next = { ...prev };
        for (const [id, params] of resolved) {
          next[id] = params;
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `assetParams` is written by this effect and read only to skip ids already resolved; listing it would re-run the effect on its own result.
  }, [assetIdsToResolve, boundNetworkId]);

  // -------------------------------------------------------------------------
  // Signer resolution. Every candidate sender's route is resolved through the
  // SAME `SecureKeyManager.resolveSigningRoute` the signer uses, on the SAME
  // network, so the method shown here is the method that will be used.
  // -------------------------------------------------------------------------
  const candidateSenders = useMemo(() => {
    const senders = new Set<string>();
    for (const txn of parsedTransactions) {
      if (!txn.from) {
        continue;
      }
      // An in-app batch (swap / claim) has no dApp and no ARC-0001 `signers`;
      // the wallet built the group for ONE account, so the widening below is
      // scoped to dApp requests only and in-app behaviour is unchanged.
      if (!walletConnect && txn.from !== account?.address) {
        continue;
      }
      senders.add(txn.from);
    }
    return [...senders];
  }, [parsedTransactions, walletConnect, account?.address]);

  /**
   * Identity of the resolution the screen currently needs. Stored WITH the
   * result so a stale result is never mistaken for the current one — the
   * alternative (clearing state at the top of the effect) is a synchronous
   * setState in an effect and a cascading render.
   */
  const resolutionKey = useMemo(
    () => [signerAttempt, boundNetworkId ?? '', ...candidateSenders].join('|'),
    [signerAttempt, boundNetworkId, candidateSenders]
  );

  useEffect(() => {
    if (candidateSenders.length === 0) {
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const accounts = await MultiAccountWalletService.getAllAccounts();
        const entries = await Promise.all(
          candidateSenders.map(
            async (address): Promise<[string, SignerResolution]> => {
              const owned = accounts.find((acc) => acc.address === address);
              if (!owned) {
                return [
                  address,
                  {
                    status: 'unavailable',
                    reason: 'This wallet does not hold this account',
                  },
                ];
              }
              const routeInfo = await SecureKeyManager.resolveSigningRoute(
                address,
                boundNetworkId
              );
              if (routeInfo.kind === 'unavailable') {
                return [
                  address,
                  { status: 'unavailable', reason: routeInfo.reason },
                ];
              }
              return [
                address,
                {
                  status: 'signable',
                  account: owned,
                  method: routeInfo.kind === 'ledger' ? 'ledger' : 'software',
                  signingAddress:
                    routeInfo.kind === 'ledger'
                      ? routeInfo.signerAddress
                      : routeInfo.signingAddress,
                  rekeyedTo: routeInfo.rekeyedTo,
                },
              ];
            }
          )
        );
        if (cancelled) {
          return;
        }
        setSignerState({
          key: resolutionKey,
          routes: Object.fromEntries(entries),
          error: null,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        // Fail closed: without a resolved signing authority we cannot name the
        // account that would sign, so nothing may be signed.
        setSignerState({
          key: resolutionKey,
          routes: {},
          error:
            error instanceof Error
              ? error.message
              : 'Could not determine which accounts can sign this request',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [candidateSenders, boundNetworkId, resolutionKey]);

  /**
   * The resolution that belongs to the CURRENT inputs, or `null` while it is
   * still in flight. A group with no candidate sender needs no lookup at all.
   */
  const activeSignerState = useMemo(() => {
    if (candidateSenders.length === 0) {
      return { routes: {} as Record<string, SignerResolution>, error: null };
    }
    if (signerState && signerState.key === resolutionKey) {
      return { routes: signerState.routes, error: signerState.error };
    }
    return null;
  }, [candidateSenders, signerState, resolutionKey]);

  const signerRoutes = activeSignerState?.routes ?? null;
  const signerError = activeSignerState?.error ?? null;

  /**
   * The per-entry signer list — the display half of the widened eligibility.
   *
   * Every entry gets exactly one visible outcome, and `reviewedSigners` is
   * derived FROM the entries shown as signing, so an account cannot sign
   * without appearing here.
   */
  const { entrySigners, reviewedSigners, primaryAccount, sequentialSigning } =
    useMemo(() => {
      if (signerRoutes === null) {
        return {
          entrySigners: parsedTransactions.map(
            () => ({ kind: 'pending' }) as EntrySigner
          ),
          reviewedSigners: [] as string[],
          primaryAccount: undefined as AccountMetadata | undefined,
          sequentialSigning: false,
        };
      }

      const binding = walletConnect?.binding ?? null;

      // Pass A — the ARC-0001 / session rules, independent of who we name.
      // `reviewedSigners: [sender]` makes rule 4 a tautology here so this pass
      // reports the substantive reason (msig / session / signers) if any.
      const base = parsedTransactions.map((txn, index) =>
        txn.from
          ? evaluateBatchEntryEligibility({
              txnSender: txn.from,
              wtxn: walletTransactions[index],
              binding,
              reviewedSigners: [txn.from],
            })
          : null
      );

      // Pass B — one auth flow serves one identity class, so the first entry we
      // could sign fixes the class for the whole request.
      let primaryClass: AuthClass | null = null;
      let primary: AccountMetadata | undefined;
      let primaryMethod: 'software' | 'ledger' = 'software';
      for (let i = 0; i < parsedTransactions.length; i++) {
        const sender = parsedTransactions[i].from;
        if (!sender || !base[i]?.eligible) {
          continue;
        }
        const resolution = signerRoutes[sender];
        if (resolution?.status !== 'signable') {
          continue;
        }
        primaryClass = authClassOf(resolution);
        primary = resolution.account;
        primaryMethod = resolution.method;
        break;
      }

      // Pass C — final, displayed outcome per entry.
      const signers: EntrySigner[] = parsedTransactions.map((txn, index) => {
        const sender = txn.from;
        if (!sender) {
          return {
            kind: 'declined',
            address: null,
            reason:
              'Not signed here — pre-signed or unreadable entry, returned to the dApp untouched',
          };
        }
        const eligibility = base[index];
        if (eligibility && !eligibility.eligible) {
          return {
            kind: 'declined',
            address: sender,
            reason: describeDeclineReason(eligibility.reason),
          };
        }
        const resolution = signerRoutes[sender];
        if (!resolution) {
          return {
            kind: 'declined',
            address: sender,
            reason:
              'Declined — this request signs only with the reviewed account',
          };
        }
        if (resolution.status === 'unavailable') {
          return {
            kind: 'declined',
            address: sender,
            reason: `Declined — ${resolution.reason}`,
          };
        }
        if (primaryClass !== null && authClassOf(resolution) !== primaryClass) {
          return {
            kind: 'declined',
            address: sender,
            reason:
              'Declined — one request cannot combine hardware and other signing methods',
          };
        }
        return { kind: 'sign', address: sender, resolution };
      });

      const named = new Set<string>();
      for (const entry of signers) {
        if (entry.kind === 'sign') {
          named.add(entry.address);
        }
      }

      return {
        entrySigners: signers,
        reviewedSigners: [...named],
        primaryAccount: primary,
        // A hardware device cannot serve concurrent signature requests.
        sequentialSigning: primaryMethod === 'ledger',
      };
    }, [parsedTransactions, walletTransactions, walletConnect, signerRoutes]);

  const signingAccounts = useMemo(() => {
    const seen = new Map<
      string,
      Extract<SignerResolution, { status: 'signable' }>
    >();
    for (const entry of entrySigners) {
      if (entry.kind === 'sign' && !seen.has(entry.address)) {
        seen.set(entry.address, entry.resolution);
      }
    }
    return [...seen.entries()];
  }, [entrySigners]);

  const signersResolved = signerRoutes !== null;

  // S-01: aggregate authority-transfer / balance-sweep dangers across all
  // transactions. Declared before handleApprove so the guard and the render
  // gating share the same scope.
  const aggregatedDangers = aggregateDangers(
    parsedTransactions.map((t) => t.dangers ?? {})
  );
  const hasDanger = hasAnyDanger(aggregatedDangers);

  const handleApprove = () => {
    if (hasDanger && !dangerAcknowledged) {
      Alert.alert(
        'Confirmation required',
        'Please acknowledge the highlighted account-security warning before signing.'
      );
      return;
    }

    // The account handed to the auth controller must be one of the accounts the
    // list named, otherwise the auth strategy could be resolved for an account
    // that never signs.
    const signingAccount = primaryAccount ?? account;
    if (!signingAccount || reviewedSigners.length === 0) {
      Alert.alert(
        'Nothing to sign',
        'No account in this request can be signed by this wallet.'
      );
      return;
    }

    // Hand the signer the REAL entries. This screen used to fabricate
    // `signers: [account.address]` for every transaction, which destroyed the
    // dApp's own instructions — including `signers: []`, i.e. "do not sign
    // this one" — before the signer ever saw them.
    const request: UnifiedTransactionRequest = {
      type: 'batch_transaction',
      account: signingAccount,
      networkId: boundNetworkId,
      walletConnectParams: {
        transactions: walletTransactions,
        // Exactly the accounts the signer list displayed. The signer re-runs
        // `evaluateBatchEntryEligibility` against this list, so an entry that
        // was not shown as signing cannot be signed.
        reviewedSigners,
        sequentialSigning,
        decodedTransactions,
        // DR-15: bind a dApp request to its session + chain; `null` declares an
        // in-app batch the wallet built itself.
        sessionBinding: walletConnect?.binding ?? null,
      },
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  };

  const handleAuthComplete = async (success: boolean, result?: any) => {
    setShowAuthModal(false);
    setCurrentRequest(null);

    if (success && onSuccess) {
      await onSuccess(result);
    } else if (!success) {
      const errorMessage =
        result instanceof Error
          ? result.message
          : 'Failed to sign transactions';
      Alert.alert('Error', errorMessage);
    }
  };

  const handleReject = async () => {
    if (onReject) {
      await onReject();
    } else {
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('Main', { screen: 'Home' });
      }
    }
  };

  /**
   * Render an integer base-unit amount EXACTLY.
   *
   * `formatAssetBalance` is not used here: it funnels through
   * `formatTokenBalance`, which does `Number(amount)` and would render a
   * uint64 above MAX_SAFE_INTEGER as something other than the value being
   * signed. `formatBaseUnitsToAmount` is exact for any bigint.
   */
  const renderAmount = useCallback(
    (txn: ParsedTransaction): string => {
      if (txn.amount === undefined) {
        return '';
      }
      if (txn.assetId === undefined || txn.assetId === 0n) {
        const value = formatBaseUnitsToAmount(txn.amount, 6);
        return networkInfo.currency
          ? `${value} ${networkInfo.currency}`
          : `${value} (unknown currency)`;
      }
      const key = txn.assetId.toString();
      if (!(key in assetParams)) {
        // Still resolving — never fall back to the network currency, which is
        // the lie this task removes.
        return '…';
      }
      const params = assetParams[key];
      if (!params) {
        // Decimals unknown: showing a scaled figure would be a guess, so the
        // exact integer is shown and labelled as such.
        return `${txn.amount.toString()} base units of ASA #${key}`;
      }
      const symbol = params.unitName || params.name || `ASA #${key}`;
      return `${formatBaseUnitsToAmount(txn.amount, params.decimals)} ${symbol}`;
    },
    [assetParams, networkInfo.currency]
  );

  const renderFee = useCallback(
    (fee: bigint): string => {
      const value = formatBaseUnitsToAmount(fee, 6);
      return networkInfo.currency
        ? `${value} ${networkInfo.currency}`
        : `${value} (unknown currency)`;
    },
    [networkInfo.currency]
  );

  const renderEntrySigner = (entry: EntrySigner) => {
    if (entry.kind === 'pending') {
      return (
        <View style={styles.signerRow}>
          <Ionicons
            name="ellipsis-horizontal-circle-outline"
            size={16}
            color={theme.colors.textMuted}
          />
          <Text style={styles.signerPending}>Resolving signer…</Text>
        </View>
      );
    }
    if (entry.kind === 'declined') {
      return (
        <View style={styles.signerRow}>
          <Ionicons
            name="close-circle-outline"
            size={16}
            color={theme.colors.textMuted}
          />
          <Text style={styles.signerDeclined}>
            {entry.address ? `${truncateAddress(entry.address)} — ` : ''}
            {entry.reason}
          </Text>
        </View>
      );
    }
    const { resolution } = entry;
    return (
      <View style={styles.signerRow}>
        <Ionicons name="key-outline" size={16} color={theme.colors.primary} />
        <Text style={styles.signerSigning}>
          Signs with {resolution.account.label} (
          {truncateAddress(entry.address)}) ·{' '}
          {resolution.method === 'ledger' ? 'Ledger' : 'Software key'}
          {resolution.rekeyedTo
            ? ` · rekeyed to ${truncateAddress(resolution.rekeyedTo)}`
            : ''}
        </Text>
      </View>
    );
  };

  const renderTransactionSummary = () => (
    <View style={styles.summaryContainer}>
      <Text style={styles.sectionTitle}>Transaction Summary</Text>

      {parsedTransactions.map((txn, index) => (
        <View key={index} style={styles.transactionItem}>
          <Text style={styles.transactionTitle}>Transaction {index + 1}</Text>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Type:</Text>
            <Text style={styles.detailValue}>{txn.type}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>From:</Text>
            <Text style={styles.detailValue}>
              {txn.from ? truncateAddress(txn.from) : 'Unknown'}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>To:</Text>
            <Text style={styles.detailValue}>{truncateAddress(txn.to)}</Text>
          </View>
          {txn.amount !== undefined && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Amount:</Text>
              <Text style={styles.detailValue}>{renderAmount(txn)}</Text>
            </View>
          )}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Fee:</Text>
            <Text style={styles.detailValue}>{renderFee(txn.fee)}</Text>
          </View>
          {txn.note && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Note:</Text>
              <Text style={styles.detailValue}>{txn.note}</Text>
            </View>
          )}
          {renderEntrySigner(entrySigners[index] ?? { kind: 'pending' })}
        </View>
      ))}
    </View>
  );

  const renderSigners = () => (
    <View style={styles.accountContainer}>
      <Text style={styles.sectionTitle}>Signing Accounts</Text>

      {!signersResolved && (
        <Text style={styles.signerPending}>
          Resolving which accounts will sign…
        </Text>
      )}

      {signersResolved && signerError && (
        <View>
          <Text style={styles.signerDeclined}>{signerError}</Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => setSignerAttempt((n) => n + 1)}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {signersResolved && !signerError && signingAccounts.length === 0 && (
        <Text style={styles.signerDeclined}>
          No account in this request can be signed by this wallet. Every entry
          will be returned unsigned.
        </Text>
      )}

      {signingAccounts.map(([address, resolution]) => (
        <View key={address} style={styles.selectedAccount}>
          <View
            style={[
              styles.accountColor,
              { backgroundColor: resolution.account.color },
            ]}
          />
          <View style={styles.accountInfo}>
            <Text style={styles.accountLabel}>{resolution.account.label}</Text>
            <Text style={styles.accountAddress}>
              {truncateAddress(address)}
            </Text>
            {resolution.rekeyedTo && (
              <Text style={styles.accountAddress}>
                Rekeyed to {truncateAddress(resolution.rekeyedTo)}
              </Text>
            )}
          </View>
          <Text style={styles.accountType}>
            {resolution.method === 'ledger' ? 'Ledger' : 'Software'}
          </Text>
        </View>
      ))}
    </View>
  );

  const canSign =
    signersResolved &&
    !signerError &&
    reviewedSigners.length > 0 &&
    (!hasDanger || dangerAcknowledged);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title={title}
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {networkInfo.known ? (
          <View style={styles.networkContainer}>
            <View style={styles.networkHeader}>
              <Ionicons name="globe" size={20} color={theme.colors.primary} />
              <Text style={styles.networkTitle}>Network</Text>
            </View>
            <Text style={styles.networkName}>{networkInfo.name}</Text>
            <Text style={styles.networkCurrency}>
              Currency: {networkInfo.currency}
            </Text>
          </View>
        ) : (
          <View style={styles.networkWarningContainer}>
            <View style={styles.networkHeader}>
              <Ionicons
                name="alert-circle"
                size={20}
                color={theme.colors.warning}
              />
              <Text style={styles.networkWarningTitle}>
                Unrecognized network
              </Text>
            </View>
            <Text style={styles.networkWarningText}>
              This wallet cannot identify the network these transactions target
              ({String(networkInfo.name)}). Amounts and fees are shown without a
              currency. Do not approve unless you know exactly what you are
              signing.
            </Text>
          </View>
        )}

        {renderTransactionSummary()}

        {hasDanger && (
          <TransactionDangerBanner
            dangers={aggregatedDangers}
            acknowledged={dangerAcknowledged}
            onToggleAcknowledged={() => setDangerAcknowledged((v) => !v)}
          />
        )}

        {renderSigners()}

        <View style={styles.warningContainer}>
          <Ionicons name="warning" size={24} color={theme.colors.warning} />
          <Text style={styles.warningText}>
            Carefully review all transaction details before signing. This action
            cannot be undone.
          </Text>
        </View>
      </ScrollView>

      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.rejectButton]}
          onPress={handleReject}
          disabled={false}
        >
          <Text style={styles.rejectButtonText}>Reject</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.approveButton]}
          onPress={handleApprove}
          disabled={!canSign}
        >
          <Text style={styles.approveButtonText}>Sign</Text>
        </TouchableOpacity>
      </View>

      <UnifiedTransactionAuthModal
        visible={showAuthModal}
        controller={authController}
        request={currentRequest}
        onComplete={handleAuthComplete}
        onCancel={() => {
          setShowAuthModal(false);
          setCurrentRequest(null);
        }}
        title="Sign Transaction"
        message="Authenticate to sign the transaction"
      />
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scrollView: {
      flex: 1,
      padding: 16,
    },
    scrollContent: {
      paddingBottom: theme.spacing.xl + 96,
    },
    networkContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    networkWarningContainer: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255,149,0,0.1)'
          : 'rgba(255,159,10,0.15)',
      borderWidth: 1,
      borderColor: theme.colors.warning + '40',
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    networkWarningTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.warning,
      marginLeft: 8,
    },
    networkWarningText: {
      fontSize: 14,
      color: theme.colors.warning,
      lineHeight: 20,
    },
    networkHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 8,
    },
    networkTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginLeft: 8,
    },
    networkName: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    networkCurrency: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    summaryContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 12,
    },
    transactionItem: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: 12,
      marginBottom: 12,
    },
    transactionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 8,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    detailLabel: {
      fontSize: 12,
      color: theme.colors.textMuted,
      flex: 1,
    },
    detailValue: {
      fontSize: 12,
      color: theme.colors.text,
      fontWeight: '500',
      flex: 2,
      textAlign: 'right',
    },
    signerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginTop: 8,
    },
    signerSigning: {
      flex: 1,
      fontSize: 12,
      color: theme.colors.text,
      marginLeft: 6,
    },
    signerDeclined: {
      flex: 1,
      fontSize: 12,
      color: theme.colors.textMuted,
      marginLeft: 6,
    },
    signerPending: {
      flex: 1,
      fontSize: 12,
      color: theme.colors.textMuted,
      marginLeft: 6,
    },
    retryButton: {
      alignSelf: 'flex-start',
      marginTop: 12,
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    retryButtonText: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    accountContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    selectedAccount: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
    },
    accountColor: {
      width: 12,
      height: 12,
      borderRadius: 6,
      marginRight: 12,
    },
    accountInfo: {
      flex: 1,
    },
    accountLabel: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 2,
    },
    accountAddress: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    accountType: {
      fontSize: 11,
      color: theme.colors.primary,
      textTransform: 'uppercase',
    },
    warningContainer: {
      flexDirection: 'row',
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255,149,0,0.1)'
          : 'rgba(255,159,10,0.15)',
      borderWidth: 1,
      borderColor: theme.colors.warning + '40',
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    warningText: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.warning,
      marginLeft: 12,
      lineHeight: 20,
    },
    buttonContainer: {
      flexDirection: 'row',
      padding: 16,
      paddingTop: 8,
      backgroundColor: theme.colors.surface,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    button: {
      flex: 1,
      height: 48,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
      marginHorizontal: 8,
    },
    rejectButton: {
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    rejectButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textMuted,
    },
    approveButton: {
      backgroundColor: theme.colors.primary,
    },
    approveButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });

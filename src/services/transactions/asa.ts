import algosdk from 'algosdk';
import { NetworkService } from '../network';
import { SecureKeyManager } from '../secure/keyManager';
import { NetworkId } from '@/types/network';

export interface AsaOptInParams {
  assetId: number;
  from: string;
  networkId?: NetworkId;
  suggestedParams?: algosdk.SuggestedParams;
}

export interface AsaOptOutParams {
  assetId: number;
  from: string;
  networkId?: NetworkId;
  creator?: string;
  suggestedParams?: algosdk.SuggestedParams;
}

/**
 * Build an ASA opt-in transaction
 * Opt-in is achieved by sending a zero amount asset transfer to yourself
 */
export async function buildAsaOptInTransaction(
  params: AsaOptInParams
): Promise<algosdk.Transaction> {
  const { assetId, from, networkId } = params;

  const networkService = networkId
    ? NetworkService.getInstance(networkId)
    : NetworkService.getInstance('voi-mainnet');

  const suggestedParams =
    params.suggestedParams || (await networkService.getSuggestedParams());

  const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: from,
    receiver: from, // Send to self
    amount: 0, // Zero amount for opt-in
    assetIndex: assetId,
    suggestedParams,
  });

  return optInTxn;
}

/**
 * Build an ASA opt-out transaction
 * Opt-out requires closing out the asset by sending entire balance back to creator
 */
export async function buildAsaOptOutTransaction(
  params: AsaOptOutParams
): Promise<algosdk.Transaction> {
  const { assetId, from, creator, networkId } = params;

  const networkService = networkId
    ? NetworkService.getInstance(networkId)
    : NetworkService.getInstance('voi-mainnet');

  const suggestedParams =
    params.suggestedParams || (await networkService.getSuggestedParams());

  // Get asset info if creator not provided
  let assetCreator = creator;
  if (!assetCreator) {
    const assetInfo = await networkService.getAlgodClient().getAssetByID(assetId).do();
    if (!assetInfo) {
      throw new Error(`Asset ${assetId} not found`);
    }
    assetCreator = assetInfo.params.creator;
  }

  // Get account info to determine balance
  const accountInfo = await networkService.getAlgodClient().accountInformation(from).do();
  const assetHolding = accountInfo.assets?.find((asset) => {
    const holdingId = Number((asset as any).assetId ?? asset['asset-id']);
    return holdingId === assetId;
  });

  if (!assetHolding) {
    throw new Error(`Account is not opted into asset ${assetId}`);
  }

  const balance = assetHolding.amount;

  const optOutTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: from,
    receiver: assetCreator, // Send remaining balance to creator
    amount: balance,
    assetIndex: assetId,
    closeRemainderTo: assetCreator, // Close out the asset
    suggestedParams,
  });

  return optOutTxn;
}

/**
 * Validate if account can opt-in to an asset
 * Checks for sufficient balance to cover MBR increase
 */
export async function validateAsaOptIn(
  address: string,
  assetId: number,
  networkId?: NetworkId
): Promise<{ valid: boolean; error?: string; mbrCost?: number }> {
  try {
    const networkService = networkId
      ? NetworkService.getInstance(networkId)
      : NetworkService.getInstance('voi-mainnet');

    // Check if already opted in
    const accountInfo = await networkService.getAlgodClient().accountInformation(address).do();

    if (!accountInfo) {
      return {
        valid: false,
        error: 'Could not fetch account information',
      };
    }

    const alreadyOptedIn = accountInfo.assets?.some((asset) => {
      const holdingId = Number((asset as any).assetId ?? asset['asset-id']);
      return holdingId === assetId;
    });

    if (alreadyOptedIn) {
      return {
        valid: false,
        error: 'Already opted into this asset',
      };
    }

    // Calculate MBR cost for opt-in (0.1 ALGO/VOI per asset)
    const MBR_PER_ASSET = 100000; // microAlgos/microVoi

    const normalizeBalanceValue = (value: unknown): number | null => {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
      }

      if (typeof value === 'bigint') {
        const asNumber = Number(value);
        return Number.isFinite(asNumber) ? asNumber : null;
      }

      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }

      return null;
    };

    const currentBalance = normalizeBalanceValue(accountInfo.amount);
    const minBalance = normalizeBalanceValue(
      accountInfo['min-balance'] ?? accountInfo.minBalance
    );

    if (currentBalance === null || minBalance === null) {
      return {
        valid: false,
        error: 'Invalid account balance information',
      };
    }

    const availableBalance = currentBalance - minBalance;

    if (availableBalance < MBR_PER_ASSET) {
      return {
        valid: false,
        error: `Insufficient balance for opt-in. Need ${MBR_PER_ASSET / 1000000} VOI for minimum balance requirement`,
        mbrCost: MBR_PER_ASSET,
      };
    }

    return {
      valid: true,
      mbrCost: MBR_PER_ASSET,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to validate opt-in: ${error.message}`,
    };
  }
}

/**
 * Validate if account can opt-out of an asset
 * Ensures balance is zero or handles close-out
 */
export async function validateAsaOptOut(
  address: string,
  assetId: number,
  networkId?: NetworkId
): Promise<{ valid: boolean; error?: string; warning?: string }> {
  try {
    const networkService = networkId
      ? NetworkService.getInstance(networkId)
      : NetworkService.getInstance('voi-mainnet');

    const accountInfo = await networkService.getAlgodClient().accountInformation(address).do();
    const assetHolding = accountInfo.assets?.find((asset) => {
      const holdingId = Number((asset as any).assetId ?? asset['asset-id']);
      return holdingId === assetId;
    });

    if (!assetHolding) {
      return {
        valid: false,
        error: 'Not opted into this asset',
      };
    }

    const balance = assetHolding.amount || 0;

    if (balance > 0) {
      return {
        valid: true,
        warning: `You have a balance of ${balance} units. This will be sent back to the asset creator.`,
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to validate opt-out: ${error.message}`,
    };
  }
}

/**
 * Sign and submit an ASA opt-in transaction
 */
export async function submitAsaOptIn(
  assetId: number,
  address: string,
  networkId: NetworkId,
  pin?: string
): Promise<string> {
  // Validate opt-in
  const validation = await validateAsaOptIn(address, assetId, networkId);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const networkService = NetworkService.getInstance(networkId);

  // Build transaction
  const txn = await buildAsaOptInTransaction({
    assetId,
    from: address,
    networkId,
  });

  // Sign transaction
  const signedTxn = await SecureKeyManager.signTransaction(txn, address, pin);

  // Submit transaction
  const txId = await networkService.submitTransaction(signedTxn);

  return txId;
}

/**
 * Sign and submit an ASA opt-out transaction
 */
export async function submitAsaOptOut(
  assetId: number,
  address: string,
  networkId: NetworkId,
  pin?: string
): Promise<string> {
  // Validate opt-out
  const validation = await validateAsaOptOut(address, assetId, networkId);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const networkService = NetworkService.getInstance(networkId);

  // Build transaction
  const txn = await buildAsaOptOutTransaction({
    assetId,
    from: address,
    networkId,
  });

  // Sign transaction
  const signedTxn = await SecureKeyManager.signTransaction(txn, address, pin);

  // Submit transaction
  const txId = await networkService.submitTransaction(signedTxn);

  return txId;
}

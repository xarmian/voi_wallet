/**
 * Types for claimable token functionality
 * Allows users to claim ARC-200 tokens that have been approved for transfer to them
 */

/**
 * Raw approval data from MimirAPI
 * Represents an ARC-200 token approval where owner has approved spender to transfer tokens
 */
export interface TokenApproval {
  /** Address of the token owner who created the approval */
  owner: string;
  /** Blockchain round when the approval was created */
  round: number;
  /** Approved amount in base units (as string for BigInt compatibility) */
  amount: string;
  /** Address with spending permission (the user who can claim) */
  spender: string;
  /** Unix timestamp of the approval */
  timestamp: number;
  /** ARC-200 contract ID */
  contractId: number;
  /** Transaction ID of the approval transaction */
  transactionId: string;
}

/**
 * Processed claimable item for UI display
 * One item per owner/token combination (same token from different owners = separate items)
 */
export interface ClaimableItem {
  /** Unique identifier: `${contractId}_${owner}` */
  id: string;
  /** ARC-200 contract ID */
  contractId: number;
  /** Token name from metadata */
  tokenName: string;
  /** Token symbol from metadata */
  tokenSymbol: string;
  /** Token decimals for display formatting */
  tokenDecimals: number;
  /** Token image URL (may be undefined if no image) */
  tokenImageUrl?: string;
  /** Whether the token is verified */
  tokenVerified: boolean;
  /** Address of the token owner */
  owner: string;
  /** Envoi name of the owner (if available) */
  ownerEnvoiName?: string;
  /** Approved amount as bigint */
  amount: bigint;
  /** Current owner balance as bigint */
  ownerBalance: bigint;
  /** Whether the claim can be executed (owner has sufficient balance) */
  isClaimable: boolean;
  /** Original approval data */
  approval: TokenApproval;
}

/**
 * Parameters for claiming a single token
 */
export interface ClaimParams {
  /** ARC-200 contract ID */
  contractId: number;
  /** Token owner address (from) */
  from: string;
  /** Recipient address (to) - usually the claimer but can be custom */
  to: string;
  /** Amount to claim in base units */
  amount: bigint;
  /** Address of the spender executing the claim (the claimer) */
  sender: string;
}

/**
 * Result of a claim transaction
 */
export interface ClaimResult {
  /** Whether the claim succeeded */
  success: boolean;
  /** Transaction ID if successful */
  transactionId?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Token metadata fetched from MimirAPI for enriching claimable items
 */
export interface ClaimableTokenMetadata {
  contractId: number;
  name: string;
  symbol: string;
  decimals: number;
  imageUrl?: string;
  verified: boolean;
}

/**
 * Serializable version of ClaimableItem for navigation params
 * bigint values are converted to strings
 */
export interface SerializableClaimableItem {
  id: string;
  contractId: number;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenImageUrl?: string;
  tokenVerified: boolean;
  owner: string;
  ownerEnvoiName?: string;
  amount: string;
  ownerBalance: string;
  isClaimable: boolean;
  approval: TokenApproval;
}

/**
 * Convert ClaimableItem to serializable form for navigation
 */
export function toSerializableClaimableItem(item: ClaimableItem): SerializableClaimableItem {
  return {
    ...item,
    amount: item.amount.toString(),
    ownerBalance: item.ownerBalance.toString(),
  };
}

/**
 * Convert serializable form back to ClaimableItem
 */
export function fromSerializableClaimableItem(item: SerializableClaimableItem): ClaimableItem {
  return {
    ...item,
    amount: BigInt(item.amount),
    ownerBalance: BigInt(item.ownerBalance),
  };
}

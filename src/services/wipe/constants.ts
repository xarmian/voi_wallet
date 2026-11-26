/**
 * TASK-469: plain names the wipe reports or deletes by name. Dependency-free so
 * a test can read them without loading native storage.
 */

/** Name reported when the wallet blob (account metadata) could not be cleared. */
export const WALLET_BLOB_NAME = 'wallet_metadata';

/** Name reported when the legacy secure-store copy of the wallet blob could not be deleted. */
export const LEGACY_WALLET_BLOB_NAME = 'wallet_metadata_legacy';

/**
 * The secure-store key an install that never migrated still holds the wallet
 * blob under (MultiAccountWalletService.WALLET_KEY; pinned by a drift test).
 */
export const LEGACY_WALLET_SECURE_KEY = 'voi_wallet_metadata';

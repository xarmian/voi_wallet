// Social and Friends types for Envoi-based social features

export interface Friend {
  id: string; // UUID
  envoiName: string; // PRIMARY KEY - e.g., "bagman.voi"
  address: string; // Resolved address (cached)
  avatar?: string; // Cached from Envoi metadata
  bio?: string; // Cached from Envoi metadata
  socialLinks?: Record<string, string>; // Cached from Envoi metadata
  addedAt: number; // Timestamp when friend was added
  isFavorite: boolean; // Star/favorite status
  lastInteraction?: number; // Last transaction timestamp
  notes?: string; // Optional private notes about this friend
  profileLastUpdated: number; // Cache timestamp for profile data
}

export interface FriendTransaction {
  friendEnvoiName: string; // Envoi name of the friend
  transactionId: string; // Transaction ID
  type: 'sent' | 'received'; // Direction relative to user
  amount: bigint; // Transaction amount
  assetId: number; // 0 for native token, otherwise ASA ID
  assetSymbol: string; // VOI, ALGO, or asset symbol
  timestamp: number; // Transaction timestamp
  note?: string; // Transaction note/memo
}

export interface CachedProfile {
  address: string;
  avatar?: string;
  bio?: string;
  socialLinks?: Record<string, string>;
  cachedAt: number;
}

// Error types
export class FriendError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'FriendError';
  }
}

export class FriendAlreadyExistsError extends FriendError {
  constructor(envoiName: string) {
    super(`Friend with Envoi name "${envoiName}" already exists`, 'FRIEND_ALREADY_EXISTS');
  }
}

export class FriendNotFoundError extends FriendError {
  constructor(envoiName: string) {
    super(`Friend with Envoi name "${envoiName}" not found`, 'FRIEND_NOT_FOUND');
  }
}

export class InvalidEnvoiNameError extends FriendError {
  constructor(envoiName: string) {
    super(`Invalid or non-existent Envoi name: "${envoiName}"`, 'INVALID_ENVOI_NAME');
  }
}

export class FriendStorageError extends FriendError {
  constructor(message: string = 'Failed to access friend storage') {
    super(message, 'FRIEND_STORAGE_ERROR');
  }
}

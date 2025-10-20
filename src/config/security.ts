/**
 * Security configuration constants for the Voi Wallet
 */

export const SECURITY_CONFIG = {
  // Minimum transaction amounts to prevent dust attacks
  MIN_VOI_TRANSACTION: 1000, // 0.001 VOI in microVOI
  MIN_ASSET_TRANSACTION: 1, // Minimum 1 unit for assets

  // PIN security settings
  PBKDF2_ITERATIONS: 100000, // 100,000 iterations
  PIN_ATTEMPT_LIMIT: 5, // Maximum PIN attempts before lockout
  PIN_LOCKOUT_DURATION: 300000, // 5 minutes in milliseconds

  // Transaction security
  MAX_DAILY_TRANSACTIONS: 100, // Maximum transactions per day
  MAX_HOURLY_TRANSACTIONS: 20, // Maximum transactions per hour
  MAX_TRANSACTION_VALUE: 1000000000000, // 1 million VOI in microVOI

  // Network security
  REQUEST_TIMEOUT: 30000, // 30 seconds
  MAX_RETRY_ATTEMPTS: 3,

  // Memory security
  KEY_CLEAR_DELAY: 5000, // Clear keys from memory after 5 seconds
  SESSION_TIMEOUT: 900000, // 15 minutes in milliseconds

  // Transaction tracking for replay protection
  MAX_TRANSACTION_CACHE: 1000, // Keep track of last 1000 transactions
  TRANSACTION_TIMEOUT: 3600000, // 1 hour - after this, transaction IDs can be reused
} as const;

export const SECURITY_MESSAGES = {
  DUST_ATTACK: `Minimum transaction amount is ${SECURITY_CONFIG.MIN_VOI_TRANSACTION / 1000000} VOI`,
  PIN_ATTEMPTS_EXCEEDED: 'Too many failed attempts. Please try again later.',
  TRANSACTION_LIMIT_EXCEEDED: 'Daily transaction limit exceeded',
  AMOUNT_TOO_LARGE: 'Transaction amount exceeds maximum allowed',
  INVALID_TRANSACTION: 'Transaction validation failed',
  REPLAY_ATTACK: 'Transaction appears to be a replay attack',
  RATE_LIMITED: 'Transaction rate limit exceeded',
} as const;

/**
 * Push Notification Types
 *
 * Types and interfaces for the notification system.
 */

/**
 * Notification event types matching the database schema
 */
export type NotificationType =
  | 'message'
  | 'voi_payment'
  | 'proposer_payout'
  | 'arc200_transfer'
  | 'arc72_transfer'
  | 'key_registration';

/**
 * User notification preferences stored in account_subscriptions table
 */
export interface NotificationPreferences {
  messages: boolean;
  voiPayments: boolean;
  /** Block-reward / proposer-payout pushes from the network fee sink; defaults to true. */
  blockRewards: boolean;
  arc200Transfers: boolean;
  arc72Transfers: boolean;
  outgoingConfirmations: boolean;
  priceAlerts: boolean;
  /** Minimum VOI amount in micro-VOI (1 VOI = 1,000,000 micro-VOI). */
  minVoiAmount: number;
  /** Minimum ARC-200 amount in normalized token units (adjusted for decimals). */
  minArc200Amount: number;
  /** Price change percentage to trigger alert */
  priceAlertThreshold: number;
}

/** Convert VOI to the stored micro-VOI unit. */
export function voiToMicroVoi(voi: number): number {
  return Math.round(voi * 1_000_000);
}

/** Convert stored micro-VOI to VOI for display. */
export function microVoiToVoi(micro: number): number {
  return micro / 1_000_000;
}

/**
 * Default notification preferences
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  messages: true,
  voiPayments: true,
  blockRewards: true,
  arc200Transfers: true,
  arc72Transfers: true,
  outgoingConfirmations: false,
  priceAlerts: false,
  minVoiAmount: 0,
  minArc200Amount: 0,
  priceAlertThreshold: 5.0,
};

/**
 * Wallet event from the wallet_events table
 * All values are in human-readable formats:
 * - Addresses: 58-char Algorand format
 * - Transaction IDs: 52-char base32 format
 * - Amounts: Normalized decimals (e.g., 1.5 VOI, not 1500000 microVOI)
 */
export interface WalletEvent {
  id: number;
  event_type: NotificationType;
  sender: string; // 58-char Algorand address
  receiver: string; // 58-char Algorand address
  txid: string | null; // 52-char base32 transaction ID
  round: number;
  intra: number | null;
  timestamp: number;
  amount: number | null; // Normalized decimal amount
  contract_id: number | null;
  token_id: string | null;
  asset_symbol: string | null;
  created_at: string;
}

/**
 * Push token record stored in push_tokens table
 */
export interface PushTokenRecord {
  id: string;
  device_id: string;
  push_token: string;
  platform: 'ios' | 'android' | 'web';
  is_valid: boolean;
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

/**
 * Account subscription record stored in account_subscriptions table
 */
export interface AccountSubscription {
  id: string;
  device_id: string;
  account_address: string; // 58-char Algorand address
  notify_messages: boolean;
  notify_voi_payments: boolean;
  notify_proposer_payouts: boolean;
  notify_arc200_transfers: boolean;
  notify_arc72_transfers: boolean;
  notify_outgoing_confirmations: boolean;
  notify_price_alerts: boolean;
  min_voi_amount: number;
  min_arc200_amount: number;
  price_alert_threshold_percent: number;
  created_at: string;
  updated_at: string;
}

/**
 * Notification data payload received from push notification
 */
export interface NotificationData {
  type:
    | 'message'
    | 'payment'
    | 'arc200'
    | 'arc72'
    | 'key_registration'
    | 'test';
  txId?: string; // 52-char base32 transaction ID
  sender?: string; // 58-char Algorand address
  receiver?: string; // 58-char Algorand address (our account that received the event)
  eventType?: NotificationType;
  round?: number;
  timestamp?: number;
  amount?: number; // Normalized decimal amount
  contractId?: number;
  tokenId?: string;
}

/**
 * Notification history record
 */
export interface NotificationHistoryRecord {
  id: string;
  device_id: string;
  account_address: string; // 58-char Algorand address
  notification_type: NotificationType;
  txid: string | null; // 52-char base32 transaction ID
  title: string;
  body: string;
  sent_at: string;
  delivered: boolean;
  tapped: boolean;
}

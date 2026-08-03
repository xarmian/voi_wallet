/**
 * Push Notification Service
 *
 * Handles push notification registration, permissions, and preferences
 * for the Voi Wallet app.
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform, AppState, AppStateStatus } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import algosdk from 'algosdk';
import {
  getSupabaseClient,
  isSupabaseConfigured,
  setDeviceId,
} from '../supabase';
import {
  NotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationData,
} from './types';
import {
  takeAccountSubscribeToken,
  isAccountSubscribeTokenCurrent,
} from './subscribePass';
import Toast from 'react-native-toast-message';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { deviceId } from '../../platform';

const LAST_HANDLED_NOTIFICATION_KEY = '@voi_wallet/last_handled_notification';

// Flag to track if notification handler has been configured
let notificationHandlerConfigured = false;

/**
 * Configure the notification handler for foreground notifications.
 * This is called lazily during initialize() to avoid triggering native module
 * access at module import time, which can crash on iOS simulator.
 */
function configureNotificationHandler(): void {
  if (notificationHandlerConfigured) {
    return;
  }
  notificationHandlerConfigured = true;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

/**
 * Notification Service
 * Singleton service for managing push notifications
 */
class NotificationService {
  private static instance: NotificationService;
  private deviceId: string | null = null;
  private pushToken: string | null = null;
  private notificationListener: Notifications.Subscription | null = null;
  private responseListener: Notifications.Subscription | null = null;
  private appStateSubscription: ReturnType<
    typeof AppState.addEventListener
  > | null = null;
  private onNotificationTap:
    | ((data: NotificationData) => void | Promise<void>)
    | null = null;
  private pendingNotificationTap: NotificationData | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  /**
   * Initialize the notification service
   * Call this early in app startup
   */
  async initialize(): Promise<void> {
    // Configure notification handler lazily to avoid iOS simulator crashes
    // This must happen before any notification operations
    configureNotificationHandler();

    if (!isSupabaseConfigured()) {
      console.log(
        'Supabase not configured, skipping notification initialization'
      );
      return;
    }

    // Get unique device ID and configure Supabase client with it
    this.deviceId = await deviceId.getDeviceId();
    setDeviceId(this.deviceId);

    // Set up notification listeners
    this.setupListeners();

    // Check if app was opened by tapping a notification (cold start)
    const lastResponse = await Notifications.getLastNotificationResponseAsync();
    if (lastResponse) {
      const notificationId = lastResponse.notification.request.identifier;
      const lastHandledId = await AsyncStorage.getItem(
        LAST_HANDLED_NOTIFICATION_KEY
      );

      // Only process if we haven't already handled this notification
      if (notificationId !== lastHandledId) {
        const data = lastResponse.notification.request.content
          .data as unknown as NotificationData;
        if (data && data.type) {
          console.log(
            '[Notifications] Cold start from notification:',
            notificationId
          );

          // Mark as handled BEFORE processing
          await AsyncStorage.setItem(
            LAST_HANDLED_NOTIFICATION_KEY,
            notificationId
          );

          if (this.onNotificationTap) {
            this.onNotificationTap(data);
          } else {
            this.pendingNotificationTap = data;
          }
        }
      }
    }

    // Set up app state listener to update last_active_at (idempotent: drop any
    // prior subscription so a repeated initialize() can't leak it).
    this.appStateSubscription?.remove();
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.handleAppStateChange
    );
  }

  /**
   * Clean up listeners
   */
  cleanup(): void {
    if (this.notificationListener) {
      this.notificationListener.remove();
      this.notificationListener = null;
    }
    if (this.responseListener) {
      this.responseListener.remove();
      this.responseListener = null;
    }
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
  }

  /**
   * Set callback for notification taps
   */
  setNotificationTapHandler(
    handler: (data: NotificationData) => void | Promise<void>
  ): void {
    this.onNotificationTap = handler;

    // If there was a pending notification tap before the handler was set, process it now
    if (this.pendingNotificationTap) {
      console.log(
        'Processing pending notification tap:',
        this.pendingNotificationTap
      );
      const pendingData = this.pendingNotificationTap;
      this.pendingNotificationTap = null;
      handler(pendingData);
    }
  }

  /**
   * Get any pending notification that was tapped before handler was ready
   */
  getPendingNotificationTap(): NotificationData | null {
    return this.pendingNotificationTap;
  }

  /**
   * Clear pending notification tap
   */
  clearPendingNotificationTap(): void {
    this.pendingNotificationTap = null;
  }

  /**
   * Request notification permissions
   * @returns true if permissions granted
   */
  async requestPermissions(): Promise<boolean> {
    if (!Device.isDevice) {
      console.warn('Push notifications only work on physical devices');
      return false;
    }

    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('Push notification permissions not granted');
      return false;
    }

    // Set up Android notification channels
    if (Platform.OS === 'android') {
      await this.setupAndroidChannels();
    }

    return true;
  }

  /**
   * Register push token with the server
   * @returns The Expo push token or null if failed
   */
  async registerPushToken(): Promise<string | null> {
    const hasPermission = await this.requestPermissions();
    if (!hasPermission) return null;

    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) return null;

    try {
      // Get Expo push token
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ||
        Constants.easConfig?.projectId;

      if (!projectId) {
        console.error('EAS project ID not configured');
        return null;
      }

      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId,
      });
      this.pushToken = tokenData.data;

      // Register with server (using voiwallet schema)
      const { error } = await supabase
        .schema('voiwallet')
        .from('push_tokens')
        .upsert(
          {
            device_id: this.deviceId,
            push_token: this.pushToken,
            platform: Platform.OS as 'ios' | 'android',
            last_active_at: new Date().toISOString(),
            is_valid: true,
          },
          {
            onConflict: 'device_id,push_token',
          }
        );

      if (error) {
        console.error('Failed to register push token:', error);
        return null;
      }

      console.log('Push token registered successfully');
      return this.pushToken;
    } catch (error) {
      console.error('Error registering push token:', error);
      return null;
    }
  }

  /**
   * Subscribe an account to notifications
   * @param address - Algorand address to subscribe (58-char format)
   * @param preferences - Notification preferences
   */
  async subscribeAccount(
    address: string,
    preferences: Partial<NotificationPreferences> = {}
  ): Promise<boolean> {
    // Validate address parameter to prevent data corruption
    const validatedAddress = this.validateAddress(address, 'subscribeAccount');
    if (!validatedAddress) {
      console.error(
        '[NotificationService] subscribeAccount called with invalid address, skipping subscription'
      );
      return false;
    }

    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) {
      console.warn('Cannot subscribe: Supabase or device ID not available');
      return false;
    }

    const prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, ...preferences };

    const { error } = await supabase
      .schema('voiwallet')
      .from('account_subscriptions')
      .upsert(
        this.buildSubscriptionRow(this.deviceId, validatedAddress, prefs),
        {
          onConflict: 'device_id,account_address',
        }
      );

    if (error) {
      console.error('Failed to subscribe account:', error);
      return false;
    }

    console.log('Account subscribed to notifications:', validatedAddress);
    return true;
  }

  /**
   * Subscribe all wallet accounts to notifications.
   *
   * Called on app startup (deferred, fire-and-forget) and when new accounts are
   * added. TASK-192 collapsed the former per-account loop — one `.single()`
   * read plus one upsert per account — into exactly ONE read and ONE write for
   * N accounts. The batching is subordinate to four correctness rules the old
   * loop got for free, and which a naive batch upsert would each destroy:
   *
   * 1. Accounts that ALREADY have preferences are excluded from the payload
   *    entirely. A blanket upsert of defaults would silently reset every user's
   *    notification settings on the next app start.
   * 2. Defaults are per account, not per batch: watch accounts cannot decrypt,
   *    so they get `messages: false` while every other type gets `true`.
   * 3. FAIL CLOSED on the read. A single batch `.select()` succeeds or fails
   *    wholesale — it cannot say which account failed — so per-account error
   *    tolerance is incoherent here. If the read fails we abort the whole pass
   *    and write nothing, retrying on the next app start. (The old loop was
   *    fail-OPEN: `getPreferences` returns null for both "absent" and "query
   *    failed", which under a batch would make an errored account look brand
   *    new and overwrite its real settings.) Aborting resolves that ambiguity
   *    by removing the path where it matters: absent from a SUCCESSFUL batch
   *    read means genuinely absent.
   * 4. Insert-if-absent (`ignoreDuplicates`), not a blanket upsert, so a
   *    preference changed on another device between the read and the write is
   *    not clobbered.
   *
   * @param accounts - Wallet accounts to subscribe.
   * @param subscribeToken - Abort token taken at launch (see `subscribePass`).
   *   Re-checked immediately before the write; a teardown or account deletion
   *   in between drops the write. Defaults to a token taken on entry, which is
   *   correct for synchronous callers that are not working from a snapshot.
   */
  async subscribeAllAccounts(
    accounts: AccountMetadata[],
    subscribeToken: number = takeAccountSubscribeToken()
  ): Promise<void> {
    if (accounts.length === 0) return;

    const supabase = getSupabaseClient();
    const deviceId = this.deviceId;
    if (!supabase || !deviceId) {
      console.warn(
        'Cannot subscribe accounts: Supabase or device ID not available'
      );
      return;
    }

    // Validate (checksum, not just length) BEFORE anything reaches the payload.
    // A batch write amplifies bad data, so a single malformed address must be
    // dropped here rather than corrupting a row. Deduplicate by address at the
    // same time: the table is keyed (device_id, account_address), so two wallet
    // entries sharing an address are one subscription. If any of them can
    // decrypt, the device can decrypt, so `messages` ORs across duplicates.
    const pending = new Map<string, { messages: boolean }>();
    for (const account of accounts) {
      const address = this.validateAddress(
        account.address,
        'subscribeAllAccounts'
      );
      if (!address) continue;

      const canDecryptMessages = account.type !== AccountType.WATCH;
      const existing = pending.get(address);
      if (existing) {
        existing.messages = existing.messages || canDecryptMessages;
      } else {
        pending.set(address, { messages: canDecryptMessages });
      }
    }

    if (pending.size === 0) return;

    const addresses = Array.from(pending.keys());

    // --- Chunked read: one query per CHUNK, not per account ---
    // `.in()` is serialised into the request URL, so an unbounded list grows
    // with wallet size and a large wallet can blow past PostgREST/proxy URL
    // limits. Combined with the fail-closed rule below that is not a degraded
    // read — it is a wallet that never subscribes anything, on every launch.
    // The old per-account loop had no aggregate limit; chunking keeps the
    // round-trip saving (N accounts -> ceil(N/50) reads, not N) without
    // reintroducing one.
    const READ_CHUNK_SIZE = 50;
    const existingRows: { account_address: string }[] = [];

    for (let i = 0; i < addresses.length; i += READ_CHUNK_SIZE) {
      const chunk = addresses.slice(i, i + READ_CHUNK_SIZE);
      const { data, error } = await supabase
        .schema('voiwallet')
        .from('account_subscriptions')
        .select('account_address')
        .eq('device_id', deviceId)
        .in('account_address', chunk);

      // Fail CLOSED, and abort the WHOLE pass on any chunk failing. Writing
      // defaults over accounts whose real preferences could not be read is the
      // one outcome the user cannot recover from, and a partially-read pass
      // cannot tell "absent" from "unread" for the chunks it never got.
      if (error || !data) {
        console.error(
          '[NotificationService] Aborting subscribe pass: failed to read existing subscriptions',
          error
        );
        return;
      }
      existingRows.push(...data);
    }

    const data = existingRows;

    const alreadySubscribed = new Set(
      (data as { account_address: string }[]).map((row) => row.account_address)
    );

    const rows = addresses
      .filter((address) => !alreadySubscribed.has(address))
      .map((address) =>
        this.buildSubscriptionRow(deviceId, address, {
          ...DEFAULT_NOTIFICATION_PREFERENCES,
          // Watch accounts can't decrypt messages, so disable by default.
          messages: pending.get(address)!.messages,
        })
      );

    if (rows.length === 0) {
      console.log(
        '[NotificationService] All accounts already subscribed, nothing to write'
      );
      return;
    }

    // Re-check the abort token as late as possible: the accounts array is a
    // snapshot taken before the read above, and an unmount or a deleteAccount
    // since then means this write would resurrect a subscription.
    if (!isAccountSubscribeTokenCurrent(subscribeToken)) {
      console.log(
        '[NotificationService] Subscribe pass superseded (teardown or account deletion); skipping write'
      );
      return;
    }

    // --- ONE write for N accounts ---
    // ignoreDuplicates => ON CONFLICT DO NOTHING: insert-if-absent, so a row
    // created or edited on another device between the read and here survives.
    const { error: writeError } = await supabase
      .schema('voiwallet')
      .from('account_subscriptions')
      .upsert(rows, {
        onConflict: 'device_id,account_address',
        ignoreDuplicates: true,
      });

    if (writeError) {
      console.error('Failed to subscribe accounts:', writeError);
      return;
    }

    console.log(
      `[NotificationService] Subscribed ${rows.length} account(s) to notifications`
    );
  }

  /**
   * Unsubscribe an account from notifications
   * @param address - Algorand address to unsubscribe (58-char format)
   */
  async unsubscribeAccount(address: string): Promise<boolean> {
    // Validate address parameter
    const validatedAddress = this.validateAddress(
      address,
      'unsubscribeAccount'
    );
    if (!validatedAddress) {
      console.error(
        '[NotificationService] unsubscribeAccount called with invalid address, skipping'
      );
      return false;
    }

    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) return false;

    const { error } = await supabase
      .schema('voiwallet')
      .from('account_subscriptions')
      .delete()
      .eq('device_id', this.deviceId)
      .eq('account_address', validatedAddress);

    if (error) {
      console.error('Failed to unsubscribe account:', error);
      return false;
    }

    console.log('Account unsubscribed from notifications:', validatedAddress);
    return true;
  }

  /**
   * Update notification preferences for an account
   * @param address - Algorand address (58-char format)
   * @param preferences - Partial preferences to update
   */
  async updatePreferences(
    address: string,
    preferences: Partial<NotificationPreferences>
  ): Promise<boolean> {
    // Validate address parameter
    const validatedAddress = this.validateAddress(address, 'updatePreferences');
    if (!validatedAddress) {
      console.error(
        '[NotificationService] updatePreferences called with invalid address, skipping'
      );
      return false;
    }

    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) return false;

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (preferences.messages !== undefined) {
      updates.notify_messages = preferences.messages;
    }
    if (preferences.voiPayments !== undefined) {
      updates.notify_voi_payments = preferences.voiPayments;
    }
    if (preferences.arc200Transfers !== undefined) {
      updates.notify_arc200_transfers = preferences.arc200Transfers;
    }
    if (preferences.arc72Transfers !== undefined) {
      updates.notify_arc72_transfers = preferences.arc72Transfers;
    }
    if (preferences.outgoingConfirmations !== undefined) {
      updates.notify_outgoing_confirmations = preferences.outgoingConfirmations;
    }
    if (preferences.priceAlerts !== undefined) {
      updates.notify_price_alerts = preferences.priceAlerts;
    }
    if (preferences.minVoiAmount !== undefined) {
      updates.min_voi_amount = preferences.minVoiAmount;
    }
    if (preferences.minArc200Amount !== undefined) {
      updates.min_arc200_amount = preferences.minArc200Amount;
    }
    if (preferences.priceAlertThreshold !== undefined) {
      updates.price_alert_threshold_percent = preferences.priceAlertThreshold;
    }

    const { error } = await supabase
      .schema('voiwallet')
      .from('account_subscriptions')
      .update(updates)
      .eq('device_id', this.deviceId)
      .eq('account_address', validatedAddress);

    if (error) {
      console.error('Failed to update preferences:', error);
      return false;
    }

    return true;
  }

  /**
   * Get notification preferences for an account
   * @param address - Algorand address (58-char format)
   */
  async getPreferences(
    address: string
  ): Promise<NotificationPreferences | null> {
    // Validate address parameter
    const validatedAddress = this.validateAddress(address, 'getPreferences');
    if (!validatedAddress) {
      return null;
    }

    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) return null;

    const { data, error } = await supabase
      .schema('voiwallet')
      .from('account_subscriptions')
      .select('*')
      .eq('device_id', this.deviceId)
      .eq('account_address', validatedAddress)
      .single();

    if (error || !data) {
      return null;
    }

    return {
      messages: data.notify_messages,
      voiPayments: data.notify_voi_payments,
      arc200Transfers: data.notify_arc200_transfers,
      arc72Transfers: data.notify_arc72_transfers,
      outgoingConfirmations: data.notify_outgoing_confirmations,
      priceAlerts: data.notify_price_alerts,
      minVoiAmount: data.min_voi_amount,
      minArc200Amount: data.min_arc200_amount,
      priceAlertThreshold: data.price_alert_threshold_percent,
    };
  }

  /**
   * Clear notification badge count
   */
  async clearBadge(): Promise<void> {
    await Notifications.setBadgeCountAsync(0);
  }

  /**
   * Get the current device ID
   */
  getDeviceId(): string | null {
    return this.deviceId;
  }

  /**
   * Check if notifications are enabled
   */
  async areNotificationsEnabled(): Promise<boolean> {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted';
  }

  // Private methods

  /**
   * Build one `account_subscriptions` row. Shared by the single-account
   * subscribe and the batch pass so both write an identical column set.
   */
  private buildSubscriptionRow(
    deviceId: string,
    address: string,
    prefs: NotificationPreferences
  ): Record<string, unknown> {
    return {
      device_id: deviceId,
      account_address: address,
      notify_messages: prefs.messages,
      notify_voi_payments: prefs.voiPayments,
      notify_arc200_transfers: prefs.arc200Transfers,
      notify_arc72_transfers: prefs.arc72Transfers,
      notify_outgoing_confirmations: prefs.outgoingConfirmations,
      notify_price_alerts: prefs.priceAlerts,
      min_voi_amount: prefs.minVoiAmount,
      min_arc200_amount: prefs.minArc200Amount,
      price_alert_threshold_percent: prefs.priceAlertThreshold,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Validate and normalize an address parameter.
   * Logs a warning and attempts recovery if an object is passed instead of a string.
   *
   * TASK-192: this used to accept ANY 58-character string — no checksum, no
   * decode — so a truncated or corrupted address passed the gate and was
   * written verbatim. It now runs the real checksum check (`isValidAddress`,
   * as `services/envoi` does), because the batch subscribe amplifies bad data
   * across a whole wallet in one write.
   *
   * @param address - The address parameter to validate
   * @param context - Method name for logging context
   * @returns Validated address string, or null if invalid
   */
  private validateAddress(address: unknown, context: string): string | null {
    // Already a valid address string
    if (typeof address === 'string' && algosdk.isValidAddress(address)) {
      return address;
    }

    // Object with address property (AccountMetadata or similar mistakenly passed)
    if (address && typeof address === 'object') {
      const obj = address as Record<string, unknown>;

      // Log warning with details for debugging
      console.warn(
        `[NotificationService] ${context}: Received object instead of address string.`,
        'Keys:',
        Object.keys(obj),
        'Has address:',
        'address' in obj,
        'Has publicKey:',
        'publicKey' in obj
      );

      // Try to extract address from the object
      if (
        'address' in obj &&
        typeof obj.address === 'string' &&
        algosdk.isValidAddress(obj.address)
      ) {
        console.warn(
          `[NotificationService] ${context}: Recovered address from object:`,
          obj.address
        );
        return obj.address;
      }
    }

    console.error(
      `[NotificationService] ${context}: Invalid address parameter:`,
      address
    );
    return null;
  }

  private setupListeners(): void {
    // Idempotent: drop any existing subscriptions before re-subscribing so a
    // repeated initialize() (without an intervening cleanup()) can't leak the
    // previous listeners.
    this.notificationListener?.remove();
    this.responseListener?.remove();

    // Handle notifications received while app is foregrounded
    this.notificationListener = Notifications.addNotificationReceivedListener(
      (notification) => {
        console.log('Notification received in foreground:', notification);

        // Show in-app toast for foreground notifications
        const { title, body, data } = notification.request.content;
        if (title || body) {
          Toast.show({
            type: 'info',
            text1: title || 'Notification',
            text2: body || undefined,
            visibilityTime: 4000,
            position: 'top',
            onPress: () => {
              // Trigger the same navigation as tapping the system notification
              Toast.hide();
              if (this.onNotificationTap && data) {
                this.onNotificationTap(data as unknown as NotificationData);
              }
            },
          });
        }
      }
    );

    // Handle notification taps
    this.responseListener =
      Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content
          .data as unknown as NotificationData;
        console.log('Notification tapped:', data);

        if (this.onNotificationTap) {
          this.onNotificationTap(data);
        } else {
          // Handler not set yet (app still initializing), store for later
          console.log('No notification tap handler set yet, storing for later');
          this.pendingNotificationTap = data;
        }
      });
  }

  private handleAppStateChange = async (
    nextAppState: AppStateStatus
  ): Promise<void> => {
    if (nextAppState === 'active') {
      // Update last_active_at when app comes to foreground
      const supabase = getSupabaseClient();
      if (supabase && this.deviceId && this.pushToken) {
        await supabase
          .schema('voiwallet')
          .from('push_tokens')
          .update({ last_active_at: new Date().toISOString() })
          .eq('device_id', this.deviceId)
          .eq('push_token', this.pushToken);
      }

      // Clear badge when app is opened
      await this.clearBadge();
    }
  };

  private async setupAndroidChannels(): Promise<void> {
    // Messages channel
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      description: 'Encrypted message notifications',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#8B5CF6',
    });

    // Transactions channel
    await Notifications.setNotificationChannelAsync('transactions', {
      name: 'Transactions',
      description: 'Payment and token transfer notifications',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250],
      lightColor: '#10B981',
    });

    // Default channel
    await Notifications.setNotificationChannelAsync('default', {
      name: 'General',
      description: 'General notifications',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
}

// Export singleton getter
export const notificationService = NotificationService.getInstance();

// Export types
export * from './types';

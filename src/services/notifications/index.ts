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
import { getSupabaseClient, isSupabaseConfigured, setDeviceId } from '../supabase';
import {
  NotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationData,
} from './types';
import Toast from 'react-native-toast-message';
import { AccountMetadata, AccountType } from '@/types/wallet';

const LAST_HANDLED_NOTIFICATION_KEY = '@voi_wallet/last_handled_notification';

// Configure notification handler for foreground notifications
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

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
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private onNotificationTap: ((data: NotificationData) => void | Promise<void>) | null = null;
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
    if (!isSupabaseConfigured()) {
      console.log('Supabase not configured, skipping notification initialization');
      return;
    }

    // Generate device ID and configure Supabase client with it
    this.deviceId = await this.generateDeviceId();
    setDeviceId(this.deviceId);

    // Set up notification listeners
    this.setupListeners();

    // Check if app was opened by tapping a notification (cold start)
    const lastResponse = await Notifications.getLastNotificationResponseAsync();
    if (lastResponse) {
      const notificationId = lastResponse.notification.request.identifier;
      const lastHandledId = await AsyncStorage.getItem(LAST_HANDLED_NOTIFICATION_KEY);

      // Only process if we haven't already handled this notification
      if (notificationId !== lastHandledId) {
        const data = lastResponse.notification.request.content.data as NotificationData;
        if (data && data.type) {
          console.log('[Notifications] Cold start from notification:', notificationId);

          // Mark as handled BEFORE processing
          await AsyncStorage.setItem(LAST_HANDLED_NOTIFICATION_KEY, notificationId);

          if (this.onNotificationTap) {
            this.onNotificationTap(data);
          } else {
            this.pendingNotificationTap = data;
          }
        }
      }
    }

    // Set up app state listener to update last_active_at
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
      Notifications.removeNotificationSubscription(this.notificationListener);
      this.notificationListener = null;
    }
    if (this.responseListener) {
      Notifications.removeNotificationSubscription(this.responseListener);
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
  setNotificationTapHandler(handler: (data: NotificationData) => void | Promise<void>): void {
    this.onNotificationTap = handler;

    // If there was a pending notification tap before the handler was set, process it now
    if (this.pendingNotificationTap) {
      console.log('Processing pending notification tap:', this.pendingNotificationTap);
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

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
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
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ||
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
      const { error } = await supabase.schema('voiwallet').from('push_tokens').upsert(
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
    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) {
      console.warn('Cannot subscribe: Supabase or device ID not available');
      return false;
    }

    const prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, ...preferences };

    const { error } = await supabase.schema('voiwallet').from('account_subscriptions').upsert(
      {
        device_id: this.deviceId,
        account_address: address,  // Use Algorand address directly
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
      },
      {
        onConflict: 'device_id,account_address',
      }
    );

    if (error) {
      console.error('Failed to subscribe account:', error);
      return false;
    }

    console.log('Account subscribed to notifications:', address);
    return true;
  }

  /**
   * Subscribe all wallet accounts to notifications
   * Called on app startup and when new accounts are added.
   * Only subscribes accounts that don't already have preferences (preserves existing settings).
   * Watch accounts have message notifications disabled by default since they can't decrypt.
   */
  async subscribeAllAccounts(accounts: AccountMetadata[]): Promise<void> {
    for (const account of accounts) {
      // Check if already subscribed - if so, don't overwrite existing preferences
      const existing = await this.getPreferences(account.address);
      if (existing) {
        console.log('Account already subscribed, skipping:', account.address);
        continue;
      }

      // Determine default preferences based on account type
      const isWatchAccount = account.type === AccountType.WATCH;
      const preferences: Partial<NotificationPreferences> = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        // Watch accounts can't decrypt messages, so disable by default
        messages: !isWatchAccount,
      };

      await this.subscribeAccount(account.address, preferences);
    }
  }

  /**
   * Unsubscribe an account from notifications
   * @param address - Algorand address to unsubscribe (58-char format)
   */
  async unsubscribeAccount(address: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) return false;

    const { error } = await supabase
      .schema('voiwallet')
      .from('account_subscriptions')
      .delete()
      .eq('device_id', this.deviceId)
      .eq('account_address', address);

    if (error) {
      console.error('Failed to unsubscribe account:', error);
      return false;
    }

    console.log('Account unsubscribed from notifications:', address);
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
      .eq('account_address', address);

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
  async getPreferences(address: string): Promise<NotificationPreferences | null> {
    const supabase = getSupabaseClient();
    if (!supabase || !this.deviceId) return null;

    const { data, error } = await supabase
      .schema('voiwallet')
      .from('account_subscriptions')
      .select('*')
      .eq('device_id', this.deviceId)
      .eq('account_address', address)
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

  private async generateDeviceId(): Promise<string> {
    // Try to get a unique device identifier
    const deviceName = Device.deviceName;
    const modelId = Device.modelId;
    const osVersion = Device.osVersion;

    // Create a semi-unique device ID from available information
    // In production, consider using expo-secure-store to persist a UUID
    const baseId = `${Platform.OS}-${modelId || 'unknown'}-${deviceName || 'device'}`;

    // Hash the ID to create a consistent identifier
    // For simplicity, we'll use a basic encoding
    const encoder = new TextEncoder();
    const data = encoder.encode(baseId + osVersion);

    // Convert to hex string
    let hash = '';
    for (let i = 0; i < data.length; i++) {
      hash += data[i].toString(16).padStart(2, '0');
    }

    return hash.slice(0, 32); // Truncate to 32 chars
  }

  private setupListeners(): void {
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
                this.onNotificationTap(data as NotificationData);
              }
            },
          });
        }
      }
    );

    // Handle notification taps
    this.responseListener = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as NotificationData;
        console.log('Notification tapped:', data);

        if (this.onNotificationTap) {
          this.onNotificationTap(data);
        } else {
          // Handler not set yet (app still initializing), store for later
          console.log('No notification tap handler set yet, storing for later');
          this.pendingNotificationTap = data;
        }
      }
    );
  }

  private handleAppStateChange = async (nextAppState: AppStateStatus): Promise<void> => {
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

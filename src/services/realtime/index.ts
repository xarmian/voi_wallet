/**
 * Realtime Service
 *
 * Manages Supabase Realtime subscriptions for instant wallet event updates.
 * Replaces polling with WebSocket-based real-time updates.
 */

import { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { AppState, AppStateStatus } from 'react-native';
import { getSupabaseClient, isSupabaseConfigured } from '../supabase';
import { WalletEvent } from '../notifications/types';

/**
 * Event handlers for different wallet event types
 */
export interface RealtimeEventHandlers {
  onMessage?: (event: WalletEvent) => void;
  onVoiPayment?: (event: WalletEvent) => void;
  onArc200Transfer?: (event: WalletEvent) => void;
  onArc72Transfer?: (event: WalletEvent) => void;
  onKeyRegistration?: (event: WalletEvent) => void;
  onAnyEvent?: (event: WalletEvent) => void;
  onConnectionChange?: (status: 'connected' | 'disconnected' | 'error') => void;
}

/**
 * Realtime Service
 * Singleton service for managing Supabase Realtime subscriptions
 */
class RealtimeService {
  private static instance: RealtimeService;
  private channel: RealtimeChannel | null = null;
  private subscribedAddresses: Set<string> = new Set();  // Algorand addresses (58-char)
  private handlers: RealtimeEventHandlers = {};
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  private constructor() {
    // Private constructor for singleton
    // Set up app state listener to handle foreground/background transitions
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.handleAppStateChange
    );
  }

  private handleAppStateChange = async (nextAppState: AppStateStatus): Promise<void> => {
    if (nextAppState === 'active') {
      // App came to foreground - reset reconnect attempts and try to reconnect if needed
      this.reconnectAttempts = 0;

      if (!this.isConnected && this.subscribedAddresses.size > 0) {
        console.log('App foregrounded, attempting to reconnect realtime...');
        await this.resubscribe();
      }
    }
  };

  /**
   * Get the singleton instance
   */
  static getInstance(): RealtimeService {
    if (!RealtimeService.instance) {
      RealtimeService.instance = new RealtimeService();
    }
    return RealtimeService.instance;
  }

  /**
   * Check if realtime is available
   */
  isAvailable(): boolean {
    return isSupabaseConfigured();
  }

  /**
   * Check if currently connected
   */
  isRealtimeConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Set event handlers
   */
  setHandlers(handlers: RealtimeEventHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Subscribe to wallet events for specific addresses
   * @param addresses - Array of Algorand addresses to subscribe to (58-char format)
   */
  async subscribeToAddresses(addresses: string[]): Promise<boolean> {
    const supabase = getSupabaseClient();
    if (!supabase) {
      console.warn('Supabase not configured, cannot subscribe to realtime');
      return false;
    }

    // Validate and store addresses (no conversion needed - use directly)
    const validAddresses = addresses.filter(addr => addr.length === 58);

    if (validAddresses.length === 0) {
      console.warn('No valid addresses to subscribe to');
      return false;
    }

    // Store subscribed addresses
    validAddresses.forEach(addr => this.subscribedAddresses.add(addr));

    // Unsubscribe from existing channel if any
    await this.unsubscribe();

    // Create new channel with unique name
    const channelName = `wallet-events-${Date.now()}`;

    // Subscribe to voiwallet.wallet_events (note: schema specified explicitly)
    this.channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'voiwallet',
          table: 'wallet_events',
        },
        (payload: RealtimePostgresChangesPayload<WalletEvent>) => {
          this.handleWalletEvent(payload.new as WalletEvent);
        }
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('Realtime subscription active');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.handlers.onConnectionChange?.('connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`Realtime subscription ${status.toLowerCase()}${err ? `: ${err.message || err}` : ''}`);
          this.isConnected = false;
          this.handlers.onConnectionChange?.('error');
          this.scheduleReconnect();
        } else if (status === 'CLOSED') {
          console.log('Realtime subscription closed');
          this.isConnected = false;
          this.handlers.onConnectionChange?.('disconnected');
        }
      });

    return true;
  }

  /**
   * Add an address to the subscription
   * @param address - Algorand address to add (58-char format)
   */
  addAddress(address: string): void {
    if (address.length === 58) {
      this.subscribedAddresses.add(address);
    }
  }

  /**
   * Remove an address from the subscription
   * @param address - Algorand address to remove (58-char format)
   */
  removeAddress(address: string): void {
    this.subscribedAddresses.delete(address);
  }

  /**
   * Unsubscribe from all wallet events
   */
  async unsubscribe(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.channel) {
      const supabase = getSupabaseClient();
      if (supabase) {
        await supabase.removeChannel(this.channel);
      }
      this.channel = null;
    }

    this.isConnected = false;
  }

  /**
   * Clear all subscriptions and handlers
   */
  async cleanup(): Promise<void> {
    await this.unsubscribe();
    this.subscribedAddresses.clear();
    this.handlers = {};
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
  }

  // Private methods

  private handleWalletEvent(event: WalletEvent): void {
    // Check if this event is relevant to our subscribed addresses
    // Now uses Algorand addresses directly (no hex conversion needed)
    const isRelevant =
      this.subscribedAddresses.has(event.receiver) ||
      this.subscribedAddresses.has(event.sender);

    if (!isRelevant) {
      // Event is not for our subscribed addresses (RLS should filter this, but double-check)
      return;
    }

    console.log('Received wallet event:', event.event_type, event.id);

    // Call the generic handler first
    this.handlers.onAnyEvent?.(event);

    // Call specific handlers based on event type
    switch (event.event_type) {
      case 'message':
        this.handlers.onMessage?.(event);
        break;
      case 'voi_payment':
        this.handlers.onVoiPayment?.(event);
        break;
      case 'arc200_transfer':
        this.handlers.onArc200Transfer?.(event);
        break;
      case 'arc72_transfer':
        this.handlers.onArc72Transfer?.(event);
        break;
      case 'key_registration':
        this.handlers.onKeyRegistration?.(event);
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('Max reconnect attempts reached, will retry on next app foreground');
      // Don't give up completely - just stop the exponential backoff loop
      // The connection will be retried when subscribeToAddresses is called again
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.pow(2, this.reconnectAttempts) * 1000;
    this.reconnectAttempts++;

    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimeout = setTimeout(async () => {
      if (this.subscribedAddresses.size > 0) {
        await this.resubscribe();
      }
    }, delay);
  }

  /**
   * Reset reconnect attempts counter
   * Call this when the app comes back to foreground to allow fresh reconnection attempts
   */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  private async resubscribe(): Promise<void> {
    const supabase = getSupabaseClient();
    if (!supabase || this.subscribedAddresses.size === 0) return;

    // Create new channel
    const channelName = `wallet-events-${Date.now()}`;

    // Resubscribe to voiwallet.wallet_events
    this.channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'voiwallet',
          table: 'wallet_events',
        },
        (payload: RealtimePostgresChangesPayload<WalletEvent>) => {
          this.handleWalletEvent(payload.new as WalletEvent);
        }
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('Realtime reconnection successful');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.handlers.onConnectionChange?.('connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`Realtime reconnection ${status.toLowerCase()}${err ? `: ${err.message || err}` : ''}`);
          this.isConnected = false;
          this.scheduleReconnect();
        }
      });
  }
}

// Export singleton getter
export const realtimeService = RealtimeService.getInstance();

// Export types
export type { RealtimeEventHandlers };

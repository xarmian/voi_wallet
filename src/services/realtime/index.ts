/**
 * Realtime Service
 *
 * Manages Supabase Realtime subscriptions for instant wallet event updates.
 *
 * REALTIME IS CURRENTLY OFF (TASK-190). Nothing in the app calls
 * `setHandlers`/`subscribeToAddresses` — the only references left are
 * commented-out code in `navigation/serviceBootstrap.ts`. This module must
 * therefore stay completely INERT until something performs a real subscribe:
 *
 *  - The singleton is NOT constructed at module import time. Importing this
 *    module (as `walletStore` does) must have no side effects.
 *  - The constructor registers nothing. The `AppState` listener is installed
 *    only when a channel is actually installed, and removed again when the
 *    subscription stops.
 *  - `addAddress`/`removeAddress` are pure bookkeeping. They exist so the
 *    address set is warm if realtime is ever re-enabled; they must never open
 *    a socket. Previously `addAddress` (called on every account create /
 *    import / watch / rekey / remote-signer add) armed the always-registered
 *    `AppState` listener, so the next foreground opened a WebSocket nobody had
 *    asked for.
 *
 * Channel lifecycle rules, so that re-enabling realtime later is safe:
 *  - `installChannel` is the ONLY path that creates a channel. Explicit
 *    subscribes, the foreground handler and the backoff timer all funnel
 *    through it, behind a single-flight chain plus a generation token
 *    (same idiom as `isLatestMultiNetworkRequest` in `store/walletStore.ts`).
 *    An install that is no longer the newest DISCARDS its channel instead of
 *    installing it.
 *  - Every install tears the previous channel down first. `resubscribe` used
 *    to overwrite `this.channel` without removing it, leaking one live
 *    `RealtimeChannel` per reconnect for the lifetime of the app.
 *  - A channel is always removed through the client that CREATED it — see
 *    `InstalledChannel` below.
 */

import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  SupabaseClient,
} from '@supabase/supabase-js';
import { AppState, AppStateStatus } from 'react-native';
import { getSupabaseClient, isSupabaseConfigured } from '../supabase';
import type { WalletEvent } from '../notifications/types';

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
 * A live channel together with the client it was created on.
 *
 * `setDeviceId()` REPLACES the Supabase singleton (`services/supabase/index.ts`
 * recreates the client to change the `x-device-id` header), so resolving the
 * client again at teardown time can hand back a different instance — one whose
 * registry never held this channel. The removal would then silently no-op and
 * the channel would stay live on the previous client forever. Always tear down
 * through the client that created the channel.
 */
interface InstalledChannel {
  channel: RealtimeChannel;
  client: SupabaseClient;
}

/**
 * Realtime Service
 * Singleton service for managing Supabase Realtime subscriptions
 */
export class RealtimeService {
  private static instance: RealtimeService | null = null;

  private installed: InstalledChannel | null = null;
  private subscribedAddresses: Set<string> = new Set(); // Algorand addresses (58-char)
  private handlers: RealtimeEventHandlers = {};
  private isConnected: boolean = false;
  /**
   * True only while a channel has genuinely been installed. Gates the
   * foreground reconnect and the backoff timer so bookkeeping alone can never
   * bring the service to life.
   */
  private isActive: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private appStateSubscription: ReturnType<
    typeof AppState.addEventListener
  > | null = null;

  /** Monotonic token; only the newest install may install its channel. */
  private installGeneration: number = 0;
  // Defence in depth against an install completing after cleanup's final sweep.
  // NOTE: the cleanup-race test below is satisfied by the synchronous clear +
  // sweep alone — this flag is NOT isolated by any test, because the fake
  // client installs too promptly to open the window it guards. Kept because a
  // real Supabase install has genuine async gaps the fake does not model, and
  // the cost is one boolean. Do not read its presence as tested behaviour.
  private shuttingDown: boolean = false;
  /** Single-flight chain: installs never interleave. Never rejects. */
  private installChain: Promise<unknown> = Promise.resolve();

  private constructor() {
    // Private constructor for the singleton. Deliberately registers NOTHING —
    // see the module header. The AppState listener is attached lazily by
    // `ensureAppStateSubscription`, on a real channel install only.
  }

  private handleAppStateChange = async (
    nextAppState: AppStateStatus
  ): Promise<void> => {
    if (nextAppState !== 'active') return;

    // App came to foreground - reset reconnect attempts and try to reconnect
    // if needed. `isActive` is belt-and-braces: this listener only exists
    // while a subscription is active.
    this.reconnectAttempts = 0;

    if (
      this.isActive &&
      !this.isConnected &&
      this.subscribedAddresses.size > 0
    ) {
      console.log('App foregrounded, attempting to reconnect realtime...');
      await this.resubscribe();
    }
  };

  /**
   * Get the singleton instance.
   *
   * Constructing it is inert, so callers may do this freely — but the instance
   * is still created lazily so that merely importing this module does nothing.
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
   * Subscribe to wallet events for specific addresses.
   *
   * This is the only public entry point that opens a connection.
   *
   * @param addresses - Array of Algorand addresses to subscribe to (58-char format)
   * @returns `true` when THIS call installed the channel. `false` when it could
   *   not (Supabase unconfigured, no valid addresses) or when a newer install
   *   superseded it — in the latter case the newer install owns the channel.
   */
  async subscribeToAddresses(addresses: string[]): Promise<boolean> {
    // Explicit intent to start again clears the cleanup latch.
    this.shuttingDown = false;
    if (!getSupabaseClient()) {
      console.warn('Supabase not configured, cannot subscribe to realtime');
      return false;
    }

    // Validate and store addresses (no conversion needed - use directly)
    const validAddresses = addresses.filter((addr) => addr.length === 58);

    if (validAddresses.length === 0) {
      console.warn('No valid addresses to subscribe to');
      return false;
    }

    // Store subscribed addresses
    validAddresses.forEach((addr) => this.subscribedAddresses.add(addr));

    return this.installChannel();
  }

  /**
   * Add an address to the subscription set.
   *
   * PURE BOOKKEEPING — this must never open a connection or register a
   * listener. Realtime only starts from an explicit `subscribeToAddresses`.
   *
   * @param address - Algorand address to add (58-char format)
   */
  addAddress(address: string): void {
    if (address.length === 58) {
      this.subscribedAddresses.add(address);
    }
  }

  /**
   * Remove an address from the subscription set.
   *
   * When the last address goes the channel is torn down: a live socket bound
   * to an empty address set can only deliver events we would immediately drop.
   *
   * @param address - Algorand address to remove (58-char format)
   */
  removeAddress(address: string): void {
    if (!this.subscribedAddresses.delete(address)) return;

    if (this.subscribedAddresses.size === 0) {
      void this.unsubscribe().catch((error) => {
        console.warn(
          'Failed to tear down realtime after the last address was removed:',
          error
        );
      });
    }
  }

  /**
   * Unsubscribe from all wallet events.
   *
   * Cancels any install still in flight, drops the AppState listener and
   * returns the service to its inert state. The address set is preserved so a
   * later `subscribeToAddresses` can pick it up again.
   */
  async unsubscribe(): Promise<void> {
    // Supersede in-flight installs so a late one cannot resurrect a channel
    // after an explicit stop.
    this.installGeneration++;
    this.isActive = false;
    this.removeAppStateSubscription();
    await this.teardownChannel();
  }

  /**
   * Clear all subscriptions and handlers
   */
  async cleanup(): Promise<void> {
    // Latch and clear SYNCHRONOUSLY, before any await. This previously awaited
    // unsubscribe() and cleared afterwards, so an install completing during
    // that await survived: its channel stayed live while the addresses,
    // handlers and AppState listener were wiped from under it, leaving a
    // channel nothing would ever tear down. The generation bump inside
    // unsubscribe() does not cover that case — such an install starts after
    // the bump and is therefore the newest.
    this.shuttingDown = true;
    this.subscribedAddresses.clear();
    this.handlers = {};
    this.removeAppStateSubscription();

    await this.unsubscribe();

    // Sweep anything that landed between the latch and here.
    await this.teardownChannel();
  }

  // Private methods

  private ensureAppStateSubscription(): void {
    if (this.appStateSubscription) return;
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.handleAppStateChange
    );
  }

  private removeAppStateSubscription(): void {
    if (!this.appStateSubscription) return;
    this.appStateSubscription.remove();
    this.appStateSubscription = null;
  }

  /**
   * Queue a channel install. Every install path goes through here.
   *
   * The generation is taken SYNCHRONOUSLY, so concurrent callers are ordered
   * the moment they arrive; the chain then runs them one at a time and every
   * one but the newest drops out. Never rejects.
   */
  private installChannel(): Promise<boolean> {
    const generation = ++this.installGeneration;

    const settled: Promise<boolean> = this.installChain
      .then(() => this.performInstall(generation))
      .catch((error) => {
        console.warn('Realtime channel install failed:', error);
        return false;
      });

    // The chain itself can never reject, so the next install always runs.
    this.installChain = settled;

    return settled;
  }

  private async performInstall(generation: number): Promise<boolean> {
    // Superseded before this install ever got its turn.
    if (generation !== this.installGeneration) return false;
    // cleanup() is tearing the service down; do not resurrect a channel.
    if (this.shuttingDown) return false;

    const supabase = getSupabaseClient();
    if (!supabase || this.subscribedAddresses.size === 0) return false;

    // Remove the previous channel BEFORE creating the next one, through the
    // client that owns it.
    await this.teardownChannel();
    if (generation !== this.installGeneration) return false;

    // Unique per install: realtime-js dedupes channels by topic only, and two
    // installs can land inside the same millisecond.
    const channelName = `wallet-events-${Date.now()}-${generation}`;

    // Subscribe to voiwallet.wallet_events (note: schema specified explicitly)
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'voiwallet',
          table: 'wallet_events',
        },
        (payload: RealtimePostgresChangesPayload<WalletEvent>) => {
          // Same rule as the status callback below: a superseded channel is
          // being (or has been) removed, and an event still in flight on it
          // would otherwise be delivered to the handlers a second time, or
          // after an explicit unsubscribe.
          if (generation !== this.installGeneration) return;
          this.handleWalletEvent(payload.new as WalletEvent);
        }
      )
      .subscribe((status, err) => {
        // A superseded (or discarded) channel must not touch shared state or
        // schedule reconnects — its status updates describe a socket nobody
        // owns any more.
        if (generation !== this.installGeneration) return;

        if (status === 'SUBSCRIBED') {
          console.log('Realtime subscription active');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.handlers.onConnectionChange?.('connected');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(
            `Realtime subscription ${status.toLowerCase()}${err ? `: ${err.message || err}` : ''}`
          );
          this.isConnected = false;
          this.handlers.onConnectionChange?.('error');
          this.scheduleReconnect();
        } else if (status === 'CLOSED') {
          console.log('Realtime subscription closed');
          this.isConnected = false;
          this.handlers.onConnectionChange?.('disconnected');
        }
      });

    if (generation !== this.installGeneration) {
      // A newer install (or an explicit unsubscribe) landed while this channel
      // was being created. Discard it rather than install it — otherwise it is
      // an orphan nobody will ever remove.
      await this.removeChannelSafely(supabase, channel);
      return false;
    }

    this.installed = { channel, client: supabase };
    this.isActive = true;
    this.ensureAppStateSubscription();

    return true;
  }

  /**
   * Remove the installed channel, if any. Does NOT bump the generation, so it
   * is safe to call from inside an install.
   */
  private async teardownChannel(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    const installed = this.installed;
    // Clear first: teardown awaits, and nothing may observe a half-removed
    // channel in the meantime.
    this.installed = null;
    this.isConnected = false;

    if (installed) {
      await this.removeChannelSafely(installed.client, installed.channel);
    }
  }

  /**
   * Remove a channel from its client. Teardown must never throw — it runs on
   * cleanup paths.
   *
   * `removeChannel` RESOLVES with 'ok' | 'timed out' | 'error'; it does not
   * reject. On 'error' realtime-js resolves without running the channel's
   * close hook, so `RealtimeClient._remove()` never runs and the channel stays
   * in the client's registry — precisely the orphan this task exists to
   * prevent, and invisible if the status is ignored. The channel is left in
   * the `leaving` state by that first attempt, which makes `_canPush()` false,
   * so a second `unsubscribe` resolves 'ok' locally and does remove it.
   */
  private async removeChannelSafely(
    client: SupabaseClient,
    channel: RealtimeChannel
  ): Promise<void> {
    try {
      const status = await client.removeChannel(channel);
      if (status === 'ok') return;

      console.warn(
        `Realtime channel removal returned "${status}", retrying once`
      );
      const retryStatus = await client.removeChannel(channel);
      if (retryStatus !== 'ok') {
        console.warn(
          `Realtime channel removal still "${retryStatus}" after retry; it may remain registered on the client`
        );
      }
    } catch (error) {
      console.warn('Failed to remove realtime channel:', error);
    }
  }

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
    // An explicit unsubscribe/cleanup stops the backoff loop dead.
    if (!this.isActive) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(
        'Max reconnect attempts reached, will retry on next app foreground'
      );
      // Don't give up completely - just stop the exponential backoff loop
      // The connection will be retried when subscribeToAddresses is called again
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.pow(2, this.reconnectAttempts) * 1000;
    this.reconnectAttempts++;

    console.log(
      `Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (this.isActive && this.subscribedAddresses.size > 0) {
        void this.resubscribe();
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

  private resubscribe(): Promise<boolean> {
    return this.installChannel();
  }
}

/**
 * Lazily resolve the singleton. Importing this module must not construct it —
 * see the module header.
 */
export function getRealtimeService(): RealtimeService {
  return RealtimeService.getInstance();
}

/** Public surface of the realtime service. */
export type RealtimeServiceApi = Pick<
  RealtimeService,
  | 'isAvailable'
  | 'isRealtimeConnected'
  | 'setHandlers'
  | 'subscribeToAddresses'
  | 'addAddress'
  | 'removeAddress'
  | 'unsubscribe'
  | 'cleanup'
  | 'resetReconnectAttempts'
>;

/**
 * Singleton facade. Kept as a value export so existing call sites (and the
 * `jest.mock(... , { realtimeService: {} })` stubs in the store specs) are
 * unchanged, but every method resolves the instance on demand rather than at
 * import time.
 */
export const realtimeService: RealtimeServiceApi = {
  isAvailable: () => getRealtimeService().isAvailable(),
  isRealtimeConnected: () => getRealtimeService().isRealtimeConnected(),
  setHandlers: (handlers) => getRealtimeService().setHandlers(handlers),
  subscribeToAddresses: (addresses) =>
    getRealtimeService().subscribeToAddresses(addresses),
  addAddress: (address) => getRealtimeService().addAddress(address),
  removeAddress: (address) => getRealtimeService().removeAddress(address),
  unsubscribe: () => getRealtimeService().unsubscribe(),
  cleanup: () => getRealtimeService().cleanup(),
  resetReconnectAttempts: () => getRealtimeService().resetReconnectAttempts(),
};

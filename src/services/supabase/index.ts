/**
 * Supabase Client Service
 *
 * Provides a singleton Supabase client for real-time subscriptions
 * and push notification management.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

// Get Supabase credentials from environment
const SUPABASE_URL = Constants.expoConfig?.extra?.supabaseUrl ||
  process.env.EXPO_PUBLIC_SUPABASE_URL;

const SUPABASE_ANON_KEY = Constants.expoConfig?.extra?.supabaseAnonKey ||
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Validate configuration
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    'Supabase credentials not configured. Real-time and push notifications will be disabled.',
    'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in your .env file.'
  );
}

// Singleton instance
let supabaseInstance: SupabaseClient | null = null;

// Store device ID for headers
let currentDeviceId: string | null = null;

/**
 * Get the Supabase client instance
 * Returns null if credentials are not configured
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }

  if (!supabaseInstance) {
    supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // No authentication needed for notifications
        persistSession: false,
        autoRefreshToken: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
      global: {
        headers: {
          'x-device-id': currentDeviceId || '',
        },
      },
    });
  }

  return supabaseInstance;
}

/**
 * Check if Supabase is configured
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Set the device ID for RLS headers
 * This recreates the Supabase client with the new headers
 * Must be called before making queries that rely on RLS policies
 */
export function setDeviceId(deviceId: string): void {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;

  currentDeviceId = deviceId;

  // Recreate the client with the new device ID header
  supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
    global: {
      headers: {
        'x-device-id': deviceId,
      },
    },
  });

  console.log('Supabase client configured with device ID');
}

/**
 * Get the current device ID
 */
export function getCurrentDeviceId(): string | null {
  return currentDeviceId;
}

// Export types for convenience
export type { SupabaseClient };

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NetworkId } from '@/types/network';

const STORAGE_KEYS = {
  SELECTED_NETWORK: 'voi_selected_network',
  PIN_TIMEOUT_MINUTES: 'voi_pin_timeout_minutes',
  CUSTOM_PIN_TIMEOUT: 'voi_custom_pin_timeout',
} as const;

export class AppStorage {
  /**
   * Save the selected network ID to persistent storage
   */
  static async saveSelectedNetwork(networkId: NetworkId): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.SELECTED_NETWORK, networkId);
    } catch (error) {
      console.error('Failed to save selected network:', error);
      throw error;
    }
  }

  /**
   * Retrieve the saved network ID from persistent storage
   * @returns Promise<NetworkId | null> - Returns null if no saved network or on error
   */
  static async getSelectedNetwork(): Promise<NetworkId | null> {
    try {
      const savedNetwork = await AsyncStorage.getItem(
        STORAGE_KEYS.SELECTED_NETWORK
      );
      return savedNetwork as NetworkId | null;
    } catch (error) {
      console.error('Failed to retrieve selected network:', error);
      return null;
    }
  }

  /**
   * Clear the saved network preference
   */
  static async clearSelectedNetwork(): Promise<void> {
    try {
      await AsyncStorage.removeItem(STORAGE_KEYS.SELECTED_NETWORK);
    } catch (error) {
      console.error('Failed to clear selected network:', error);
      throw error;
    }
  }

  /**
   * Save PIN timeout preference to persistent storage
   * @param timeout - Number of minutes or 'never' for no timeout
   */
  static async savePinTimeout(timeout: number | 'never'): Promise<void> {
    try {
      await AsyncStorage.setItem(
        STORAGE_KEYS.PIN_TIMEOUT_MINUTES,
        String(timeout)
      );
    } catch (error) {
      console.error('Failed to save PIN timeout:', error);
      throw error;
    }
  }

  /**
   * Retrieve the saved PIN timeout preference
   * @returns Promise<number | 'never' | null> - Returns null if no saved timeout or on error
   */
  static async getPinTimeout(): Promise<number | 'never' | null> {
    try {
      const savedTimeout = await AsyncStorage.getItem(
        STORAGE_KEYS.PIN_TIMEOUT_MINUTES
      );
      if (!savedTimeout) return null;

      if (savedTimeout === 'never') return 'never';

      const timeoutNumber = Number(savedTimeout);
      return isNaN(timeoutNumber) ? null : timeoutNumber;
    } catch (error) {
      console.error('Failed to retrieve PIN timeout:', error);
      return null;
    }
  }

  /**
   * Save custom PIN timeout value
   * @param minutes - Custom timeout in minutes
   */
  static async saveCustomPinTimeout(minutes: number): Promise<void> {
    try {
      await AsyncStorage.setItem(
        STORAGE_KEYS.CUSTOM_PIN_TIMEOUT,
        String(minutes)
      );
    } catch (error) {
      console.error('Failed to save custom PIN timeout:', error);
      throw error;
    }
  }

  /**
   * Retrieve the saved custom PIN timeout value
   * @returns Promise<number | null> - Returns null if no saved timeout or on error
   */
  static async getCustomPinTimeout(): Promise<number | null> {
    try {
      const savedTimeout = await AsyncStorage.getItem(
        STORAGE_KEYS.CUSTOM_PIN_TIMEOUT
      );
      if (!savedTimeout) return null;

      const timeoutNumber = Number(savedTimeout);
      return isNaN(timeoutNumber) ? null : timeoutNumber;
    } catch (error) {
      console.error('Failed to retrieve custom PIN timeout:', error);
      return null;
    }
  }

  /**
   * Clear PIN timeout preferences
   */
  static async clearPinTimeoutPreferences(): Promise<void> {
    try {
      await Promise.all([
        AsyncStorage.removeItem(STORAGE_KEYS.PIN_TIMEOUT_MINUTES),
        AsyncStorage.removeItem(STORAGE_KEYS.CUSTOM_PIN_TIMEOUT),
      ]);
    } catch (error) {
      console.error('Failed to clear PIN timeout preferences:', error);
      throw error;
    }
  }
}

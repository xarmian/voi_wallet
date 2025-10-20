import AsyncStorage from '@react-native-async-storage/async-storage';

export type AssetSortBy = 'name' | 'balance' | 'value';
export type AssetSortOrder = 'asc' | 'desc';

const STORAGE_KEYS = {
  ASSET_SORT_BY: '@wallet-asset-sort-by',
  ASSET_SORT_ORDER: '@wallet-asset-sort-order',
  ASSET_FILTER_BALANCE_THRESHOLD: '@wallet-asset-filter-balance-threshold',
  ASSET_FILTER_VALUE_THRESHOLD: '@wallet-asset-filter-value-threshold',
  ASSET_NATIVE_TOKENS_FIRST: '@wallet-asset-native-tokens-first',
} as const;

export interface AssetFilterSettings {
  sortBy: AssetSortBy;
  sortOrder: AssetSortOrder;
  balanceThreshold: number | null;
  valueThreshold: number | null;
  nativeTokensFirst: boolean;
}

export const DEFAULT_ASSET_FILTER_SETTINGS: AssetFilterSettings = {
  sortBy: 'value',
  sortOrder: 'desc',
  balanceThreshold: null,
  valueThreshold: null,
  nativeTokensFirst: true,
};

export class AssetFilterStorage {
  /**
   * Save asset sort by preference
   */
  static async saveAssetSortBy(sortBy: AssetSortBy): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.ASSET_SORT_BY, sortBy);
    } catch (error) {
      console.error('Failed to save asset sort by:', error);
      throw error;
    }
  }

  /**
   * Get asset sort by preference
   */
  static async getAssetSortBy(): Promise<AssetSortBy | null> {
    try {
      const value = await AsyncStorage.getItem(STORAGE_KEYS.ASSET_SORT_BY);
      if (value && ['name', 'balance', 'value'].includes(value)) {
        return value as AssetSortBy;
      }
      return null;
    } catch (error) {
      console.error('Failed to get asset sort by:', error);
      return null;
    }
  }

  /**
   * Save asset sort order preference
   */
  static async saveAssetSortOrder(sortOrder: AssetSortOrder): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.ASSET_SORT_ORDER, sortOrder);
    } catch (error) {
      console.error('Failed to save asset sort order:', error);
      throw error;
    }
  }

  /**
   * Get asset sort order preference
   */
  static async getAssetSortOrder(): Promise<AssetSortOrder | null> {
    try {
      const value = await AsyncStorage.getItem(STORAGE_KEYS.ASSET_SORT_ORDER);
      if (value && ['asc', 'desc'].includes(value)) {
        return value as AssetSortOrder;
      }
      return null;
    } catch (error) {
      console.error('Failed to get asset sort order:', error);
      return null;
    }
  }

  /**
   * Save asset balance threshold filter
   */
  static async saveBalanceThreshold(threshold: number | null): Promise<void> {
    try {
      if (threshold === null) {
        await AsyncStorage.removeItem(STORAGE_KEYS.ASSET_FILTER_BALANCE_THRESHOLD);
      } else {
        await AsyncStorage.setItem(
          STORAGE_KEYS.ASSET_FILTER_BALANCE_THRESHOLD,
          String(threshold)
        );
      }
    } catch (error) {
      console.error('Failed to save balance threshold:', error);
      throw error;
    }
  }

  /**
   * Get asset balance threshold filter
   */
  static async getBalanceThreshold(): Promise<number | null> {
    try {
      const value = await AsyncStorage.getItem(
        STORAGE_KEYS.ASSET_FILTER_BALANCE_THRESHOLD
      );
      if (!value) return null;

      const parsed = parseFloat(value);
      return isNaN(parsed) ? null : parsed;
    } catch (error) {
      console.error('Failed to get balance threshold:', error);
      return null;
    }
  }

  /**
   * Save asset value threshold filter (USD)
   */
  static async saveValueThreshold(threshold: number | null): Promise<void> {
    try {
      if (threshold === null) {
        await AsyncStorage.removeItem(STORAGE_KEYS.ASSET_FILTER_VALUE_THRESHOLD);
      } else {
        await AsyncStorage.setItem(
          STORAGE_KEYS.ASSET_FILTER_VALUE_THRESHOLD,
          String(threshold)
        );
      }
    } catch (error) {
      console.error('Failed to save value threshold:', error);
      throw error;
    }
  }

  /**
   * Get asset value threshold filter (USD)
   */
  static async getValueThreshold(): Promise<number | null> {
    try {
      const value = await AsyncStorage.getItem(
        STORAGE_KEYS.ASSET_FILTER_VALUE_THRESHOLD
      );
      if (!value) return null;

      const parsed = parseFloat(value);
      return isNaN(parsed) ? null : parsed;
    } catch (error) {
      console.error('Failed to get value threshold:', error);
      return null;
    }
  }

  /**
   * Save native tokens first preference
   */
  static async saveNativeTokensFirst(nativeFirst: boolean): Promise<void> {
    try {
      await AsyncStorage.setItem(
        STORAGE_KEYS.ASSET_NATIVE_TOKENS_FIRST,
        String(nativeFirst)
      );
    } catch (error) {
      console.error('Failed to save native tokens first:', error);
      throw error;
    }
  }

  /**
   * Get native tokens first preference
   */
  static async getNativeTokensFirst(): Promise<boolean | null> {
    try {
      const value = await AsyncStorage.getItem(
        STORAGE_KEYS.ASSET_NATIVE_TOKENS_FIRST
      );
      if (value === null) return null;
      return value === 'true';
    } catch (error) {
      console.error('Failed to get native tokens first:', error);
      return null;
    }
  }

  /**
   * Load all asset filter settings at once
   */
  static async loadAssetFilterSettings(): Promise<AssetFilterSettings> {
    try {
      const [sortBy, sortOrder, balanceThreshold, valueThreshold, nativeTokensFirst] =
        await Promise.all([
          this.getAssetSortBy(),
          this.getAssetSortOrder(),
          this.getBalanceThreshold(),
          this.getValueThreshold(),
          this.getNativeTokensFirst(),
        ]);

      return {
        sortBy: sortBy || DEFAULT_ASSET_FILTER_SETTINGS.sortBy,
        sortOrder: sortOrder || DEFAULT_ASSET_FILTER_SETTINGS.sortOrder,
        balanceThreshold: balanceThreshold,
        valueThreshold: valueThreshold,
        nativeTokensFirst: nativeTokensFirst ?? DEFAULT_ASSET_FILTER_SETTINGS.nativeTokensFirst,
      };
    } catch (error) {
      console.error('Failed to load asset filter settings:', error);
      return DEFAULT_ASSET_FILTER_SETTINGS;
    }
  }

  /**
   * Save all asset filter settings at once
   */
  static async saveAssetFilterSettings(
    settings: AssetFilterSettings
  ): Promise<void> {
    try {
      await Promise.all([
        this.saveAssetSortBy(settings.sortBy),
        this.saveAssetSortOrder(settings.sortOrder),
        this.saveBalanceThreshold(settings.balanceThreshold),
        this.saveValueThreshold(settings.valueThreshold),
        this.saveNativeTokensFirst(settings.nativeTokensFirst),
      ]);
    } catch (error) {
      console.error('Failed to save asset filter settings:', error);
      throw error;
    }
  }

  /**
   * Reset all asset filter settings to defaults
   */
  static async resetAssetFilterSettings(): Promise<void> {
    try {
      await Promise.all([
        AsyncStorage.removeItem(STORAGE_KEYS.ASSET_SORT_BY),
        AsyncStorage.removeItem(STORAGE_KEYS.ASSET_SORT_ORDER),
        AsyncStorage.removeItem(STORAGE_KEYS.ASSET_FILTER_BALANCE_THRESHOLD),
        AsyncStorage.removeItem(STORAGE_KEYS.ASSET_FILTER_VALUE_THRESHOLD),
        AsyncStorage.removeItem(STORAGE_KEYS.ASSET_NATIVE_TOKENS_FIRST),
      ]);
    } catch (error) {
      console.error('Failed to reset asset filter settings:', error);
      throw error;
    }
  }
}

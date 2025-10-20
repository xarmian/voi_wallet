import algosdk from 'algosdk';
import EnvoiService, { EnvoiNameInfo } from '@/services/envoi';
import VoiNetworkService from '@/services/network';

// Cache for formatted address results to maintain stable references
const formatCache = new Map<
  string,
  {
    address: string;
    nameInfo: EnvoiNameInfo | null;
    result: FormattedAddress;
  }
>();

export interface FormattedAddress {
  displayText: string;
  fullAddress: string;
  envoiName?: string;
  hasName: boolean;
}

/**
 * Format an address with Envoi name if available
 * Returns a stable object reference to prevent React re-renders
 */
export const formatAddressWithName = async (
  address: string,
  options: {
    showFullAddress?: boolean;
    prefixLength?: number;
    suffixLength?: number;
  } = {}
): Promise<FormattedAddress> => {
  const {
    showFullAddress = false,
    prefixLength = 6,
    suffixLength = 4,
  } = options;

  // Validate address first
  if (!address || !algosdk.isValidAddress(address)) {
    return {
      displayText: address || 'Invalid Address',
      fullAddress: address || '',
      hasName: false,
    };
  }

  // Try to get name from Envoi if it's enabled on current network
  let nameInfo: EnvoiNameInfo | null = null;
  if (VoiNetworkService.isFeatureAvailable('envoi')) {
    const envoiService = EnvoiService.getInstance();
    nameInfo = await envoiService.getName(address);
  }

  // Check cache for stable reference
  const cacheKey = `${address}-${showFullAddress}-${prefixLength}-${suffixLength}`;
  const cached = formatCache.get(cacheKey);
  if (cached && cached.address === address && cached.nameInfo === nameInfo) {
    return cached.result;
  }

  // Create formatted address result
  let displayText: string;

  if (nameInfo?.name) {
    // Show name if available
    displayText = nameInfo.name;
  } else if (showFullAddress) {
    // Show full address if requested
    displayText = address;
  } else {
    // Show shortened address
    displayText = `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
  }

  const result: FormattedAddress = Object.freeze({
    displayText,
    fullAddress: address,
    envoiName: nameInfo?.name,
    hasName: Boolean(nameInfo?.name),
  });

  // Cache the result
  formatCache.set(cacheKey, { address, nameInfo, result });

  return result;
};

/**
 * Synchronous version that only uses cached data
 * Useful for components that need immediate results
 */
export const formatAddressSync = (
  address: string,
  nameInfo: EnvoiNameInfo | null = null,
  options: {
    showFullAddress?: boolean;
    prefixLength?: number;
    suffixLength?: number;
  } = {}
): FormattedAddress => {
  const {
    showFullAddress = false,
    prefixLength = 6,
    suffixLength = 4,
  } = options;

  // Validate address first
  if (!address || !algosdk.isValidAddress(address)) {
    return {
      displayText: address || 'Invalid Address',
      fullAddress: address || '',
      hasName: false,
    };
  }

  let displayText: string;

  if (nameInfo?.name) {
    displayText = nameInfo.name;
  } else if (showFullAddress) {
    displayText = address;
  } else {
    displayText = `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
  }

  return {
    displayText,
    fullAddress: address,
    envoiName: nameInfo?.name,
    hasName: Boolean(nameInfo?.name),
  };
};

/**
 * Legacy function to maintain backward compatibility
 * Just formats the address without name lookup
 */
export const formatAddress = (
  address: string,
  prefixLength = 6,
  suffixLength = 4
): string => {
  if (!address || !algosdk.isValidAddress(address)) {
    return address || 'Invalid Address';
  }
  return `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
};

/**
 * Resolve an input that could be either an address or Envoi name
 * Returns the resolved address or null if invalid
 */
export const resolveAddressOrName = async (
  input: string
): Promise<string | null> => {
  if (!input?.trim()) {
    return null;
  }

  const trimmed = input.trim();

  // If it's already a valid address, return it
  if (algosdk.isValidAddress(trimmed)) {
    return trimmed;
  }

  // If it looks like an Envoi name and Envoi is enabled, try to resolve it
  if (
    EnvoiService.isValidNameFormat(trimmed) &&
    VoiNetworkService.isFeatureAvailable('envoi')
  ) {
    const envoiService = EnvoiService.getInstance();
    const nameInfo = await envoiService.getAddress(trimmed);
    return nameInfo?.address || null;
  }

  return null;
};

/**
 * Check if an input looks like an Envoi name rather than an address
 * Only returns true if Envoi is enabled on the current network
 */
export const isLikelyEnvoiName = (input: string): boolean => {
  if (!input?.trim()) {
    return false;
  }

  // If Envoi is not enabled on current network, no input can be an Envoi name
  if (!VoiNetworkService.isFeatureAvailable('envoi')) {
    return false;
  }

  const trimmed = input.trim();

  // If it's a valid address, it's not a name
  if (algosdk.isValidAddress(trimmed)) {
    return false;
  }

  // Check if it matches Envoi name format
  return EnvoiService.isValidNameFormat(trimmed);
};

/**
 * Clear expired entries from the format cache
 */
export const clearFormatCache = (): void => {
  formatCache.clear();
};

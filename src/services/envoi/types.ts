// Envoi API response types based on https://api.envoi.sh documentation

export interface EnvoiNameInfo {
  name: string;
  address: string;
  avatar?: string;
  socialLinks?: Record<string, string>;
}

export interface EnvoiTokenInfo {
  name: string;
  owner: string;
  metadata?: Record<string, any>;
}

export interface EnvoiSearchResult {
  name: string;
  address: string;
  avatar?: string;
}

export interface EnvoiApiConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
}

export class EnvoiApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'EnvoiApiError';
  }
}

// Cache types for managing resolved names and addresses
export interface EnvoiCacheEntry {
  data: EnvoiNameInfo | null;
  timestamp: number;
  isLoading: boolean;
}

export interface EnvoiCache {
  namesByAddress: Map<string, EnvoiCacheEntry>;
  addressesByName: Map<string, EnvoiCacheEntry>;
}

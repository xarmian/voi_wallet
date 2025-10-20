export const NFT_CONSTANTS = {
  ALGORAND_ADDRESS_LENGTH: 58,
  MAX_METADATA_SIZE: 50000, // 50KB limit for metadata JSON
  REQUEST_TIMEOUT: 10000, // 10 seconds
  BASE_URL: 'https://arc72-voi-mainnet.nftnavigator.xyz/nft-indexer/v1',
  MAX_IMAGE_CACHE_SIZE: 100, // Maximum number of images to track errors for
} as const;

export const NFT_ERROR_MESSAGES = {
  INVALID_ADDRESS: 'Invalid wallet address format',
  NETWORK_TIMEOUT: 'Request timeout: NFT fetch took too long',
  METADATA_TOO_LARGE: 'NFT metadata is too large to process',
  INVALID_METADATA_STRUCTURE: 'Invalid NFT metadata structure',
  FETCH_FAILED: 'Failed to fetch NFTs. Please try again.',
} as const;

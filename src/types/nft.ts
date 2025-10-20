export interface NFTMetadata {
  name: string;
  description?: string;
  image?: string;
  image_integrity?: string;
  image_mimetype?: string;
  properties?: Record<string, any>;
  royalties?: string;
}

export interface ARC72Token {
  contractId: number;
  tokenId: string;
  owner: string;
  metadataURI: string;
  metadata: string; // JSON string that needs to be parsed
  approved: string;
  'mint-round': number;
  isBurned: boolean;
}

export interface NFTToken {
  contractId: number;
  tokenId: string;
  owner: string;
  metadataURI: string;
  metadata: NFTMetadata;
  approved: string;
  mintRound: number;
  isBurned: boolean;
  imageUrl?: string;
  networkId?: string; // Network where this NFT exists (defaults to Voi)
}

export interface NFTIndexerResponse {
  currentRound: number;
  tokens: ARC72Token[];
  'next-token'?: number;
}

export interface NFTCollectionResponse {
  currentRound: number;
  tokens: NFTToken[];
  nextToken?: number;
}

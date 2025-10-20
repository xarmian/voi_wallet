import {
  NFTIndexerResponse,
  NFTCollectionResponse,
  NFTToken,
  ARC72Token,
  NFTMetadata,
} from '@/types/nft';
import { NFT_CONSTANTS, NFT_ERROR_MESSAGES } from '@/constants/nft';

export class NFTService {
  /**
   * Validate Algorand address format
   */
  private static validateAlgorandAddress(address: string): void {
    if (!address || typeof address !== 'string') {
      throw new Error(NFT_ERROR_MESSAGES.INVALID_ADDRESS);
    }

    if (address.length !== NFT_CONSTANTS.ALGORAND_ADDRESS_LENGTH) {
      throw new Error(NFT_ERROR_MESSAGES.INVALID_ADDRESS);
    }

    if (!/^[A-Z2-7]+$/.test(address)) {
      throw new Error(NFT_ERROR_MESSAGES.INVALID_ADDRESS);
    }
  }

  /**
   * Create a fetch request with timeout protection
   */
  private static async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      NFT_CONSTANTS.REQUEST_TIMEOUT
    );

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(NFT_ERROR_MESSAGES.NETWORK_TIMEOUT);
      }
      throw error;
    }
  }

  /**
   * Fetch NFTs owned by a specific address
   */
  static async fetchUserNFTs(
    ownerAddress: string
  ): Promise<NFTCollectionResponse> {
    // Validate the address before making the request
    this.validateAlgorandAddress(ownerAddress);

    try {
      const url = `${NFT_CONSTANTS.BASE_URL}/tokens?owner=${ownerAddress}`;
      const response = await this.fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch NFTs: ${response.status} ${response.statusText}`
        );
      }

      const data: NFTIndexerResponse = await response.json();

      // Transform and parse the NFT data
      const transformedTokens = data.tokens.map((token) =>
        this.transformARC72Token(token)
      );

      return {
        currentRound: data.currentRound,
        tokens: transformedTokens,
        nextToken: data['next-token'],
      };
    } catch (error) {
      console.error('Error fetching NFTs:', error);
      throw error;
    }
  }

  /**
   * Safely parse and validate JSON metadata
   */
  private static parseMetadata(
    metadataString: string,
    tokenId: string
  ): NFTMetadata {
    // Check size limit to prevent DoS attacks
    if (metadataString.length > NFT_CONSTANTS.MAX_METADATA_SIZE) {
      console.warn(`Metadata too large for token ${tokenId}`);
      return { name: `Token #${tokenId}` };
    }

    try {
      const parsed = JSON.parse(metadataString);

      // Validate structure
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(NFT_ERROR_MESSAGES.INVALID_METADATA_STRUCTURE);
      }

      // Ensure required fields have safe defaults
      return {
        name:
          typeof parsed.name === 'string' ? parsed.name : `Token #${tokenId}`,
        description:
          typeof parsed.description === 'string'
            ? parsed.description
            : undefined,
        image: typeof parsed.image === 'string' ? parsed.image : undefined,
        image_integrity:
          typeof parsed.image_integrity === 'string'
            ? parsed.image_integrity
            : undefined,
        image_mimetype:
          typeof parsed.image_mimetype === 'string'
            ? parsed.image_mimetype
            : undefined,
        properties:
          parsed.properties && typeof parsed.properties === 'object'
            ? parsed.properties
            : undefined,
        royalties:
          typeof parsed.royalties === 'string' ? parsed.royalties : undefined,
      };
    } catch (error) {
      console.warn(`Failed to parse metadata for token ${tokenId}:`, error);
      return { name: `Token #${tokenId}` };
    }
  }

  /**
   * Transform ARC72Token to NFTToken with parsed metadata
   */
  private static transformARC72Token(token: ARC72Token): NFTToken {
    const parsedMetadata = token.metadata
      ? this.parseMetadata(token.metadata, token.tokenId)
      : { name: `Token #${token.tokenId}` };

    // Extract and validate image URL from metadata
    const imageUrl = this.validateImageUrl(parsedMetadata.image);

    return {
      contractId: token.contractId,
      tokenId: token.tokenId,
      owner: token.owner,
      metadataURI: token.metadataURI,
      metadata: parsedMetadata,
      approved: token.approved,
      mintRound: token['mint-round'],
      isBurned: token.isBurned,
      imageUrl,
    };
  }

  /**
   * Get display name for an NFT
   */
  static getDisplayName(nft: NFTToken): string {
    return nft.metadata.name || `Token #${nft.tokenId}`;
  }

  /**
   * Get contract identifier string
   */
  static getContractIdentifier(nft: NFTToken): string {
    return `${nft.contractId}:${nft.tokenId}`;
  }

  /**
   * Validate and sanitize image URL
   */
  private static validateImageUrl(imageUrl?: string): string | undefined {
    if (!imageUrl || typeof imageUrl !== 'string') {
      return undefined;
    }

    try {
      const url = new URL(imageUrl);
      // Only allow HTTP/HTTPS protocols
      if (!['http:', 'https:'].includes(url.protocol)) {
        return undefined;
      }
      // Ensure hostname exists
      if (!url.hostname || url.hostname.length === 0) {
        return undefined;
      }
      return imageUrl;
    } catch {
      return undefined;
    }
  }

  /**
   * Check if NFT has a valid image
   */
  static hasValidImage(nft: NFTToken): boolean {
    return !!(nft.imageUrl && this.validateImageUrl(nft.imageUrl));
  }

  /**
   * Format properties for display
   */
  static formatProperties(
    nft: NFTToken
  ): Array<{ key: string; value: string }> {
    if (!nft.metadata.properties) {
      return [];
    }

    return Object.entries(nft.metadata.properties).map(([key, value]) => ({
      key: key.charAt(0).toUpperCase() + key.slice(1),
      value: String(value),
    }));
  }
}

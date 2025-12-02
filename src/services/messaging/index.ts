/**
 * Messaging Service
 *
 * High-level service for sending and receiving E2E encrypted messages
 * using blockchain transaction notes.
 *
 * V2: Uses signature-derived encryption for hardware wallet compatibility
 * and improved security (private key never directly used in ECDH).
 */

import { NetworkService } from '@/services/network';
import { TransactionService, TransactionParams } from '@/services/transactions';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { NetworkId } from '@/types/network';
import { WalletAccount } from '@/types/wallet';
import {
  Message,
  MessageDirection,
  SendMessageRequest,
  SendMessageResult,
  MESSAGE_FEE_MICRO,
  EncryptedMessagePayloadV2,
  MessagingKeyPair,
} from './types';
import {
  encryptMessageV2,
  decryptMessageV2,
  createMessageNoteV2,
  parseMessageNoteAny,
  verifySender,
  extractPublicKeyFromSecret,
} from './crypto';
import {
  deriveMessagingKeyPairFromSecret,
  getCachedKeyPair,
  clearCachedKey,
  clearAllCachedKeys,
} from './keyDerivation';
import {
  lookupMessagingKey,
  registerMessagingKey,
  isMessagingKeyRegistered,
  getMessagingPublicKey,
} from './keyRegistry';

/**
 * MessagingService handles all messaging operations.
 * Uses singleton pattern for consistent state.
 */
export class MessagingService {
  private static instance: MessagingService;

  private constructor() {}

  static getInstance(): MessagingService {
    if (!MessagingService.instance) {
      MessagingService.instance = new MessagingService();
    }
    return MessagingService.instance;
  }

  /**
   * Get the message fee in microVOI
   */
  getMessageFee(): number {
    return MESSAGE_FEE_MICRO;
  }

  /**
   * Send an encrypted message to a recipient using v2 encryption.
   *
   * @param request - Message send request containing recipient, content, and sender
   * @param pin - Optional PIN for key decryption
   * @returns Transaction ID and created message object
   * @throws Error if recipient hasn't registered their messaging key
   */
  async sendMessage(
    request: SendMessageRequest,
    pin?: string
  ): Promise<SendMessageResult> {
    // Get the current wallet and find the sender account
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const account = wallet.accounts.find(
      (acc) => acc.address === request.senderAddress
    );
    if (!account) {
      throw new Error('Sender account not found');
    }

    // Look up recipient's messaging public key
    const recipientMessagingKey = await getMessagingPublicKey(request.recipientAddress);
    if (!recipientMessagingKey) {
      throw new Error(
        'Recipient has not registered for encrypted messaging. They must enable messaging first.'
      );
    }

    // Get the private key to extract sender's public key
    const privateKey = await AccountSecureStorage.getPrivateKey(account.id, pin);

    try {
      // Extract sender's Ed25519 public key for identification
      const senderPublicKey = extractPublicKeyFromSecret(privateKey);

      // Encrypt the message using v2 scheme
      const encryptedPayload = await encryptMessageV2(
        request.content,
        senderPublicKey,
        recipientMessagingKey
      );

      // Create ARC-2 compliant note
      const noteString = createMessageNoteV2(encryptedPayload);

      // Build transaction params with 0 amount (just paying the fee)
      const params: TransactionParams = {
        from: request.senderAddress,
        to: request.recipientAddress,
        amount: 0,
        note: noteString,
        assetType: 'voi',
        networkId: NetworkId.VOI_MAINNET,
      };

      // Send the transaction
      const txId = await TransactionService.sendTransaction(
        params,
        account as WalletAccount,
        pin
      );

      // Create the message object
      const message: Message = {
        id: txId,
        threadId: request.recipientAddress,
        direction: 'sent',
        content: request.content,
        timestamp: encryptedPayload.t,
        status: 'confirmed',
        fee: MESSAGE_FEE_MICRO,
      };

      return { txId, message };
    } finally {
      // Always zero-fill the private key
      privateKey.fill(0);
    }
  }

  /**
   * Fetch and decrypt messages between user and a specific friend.
   *
   * @param userAddress - Current user's address
   * @param friendAddress - Friend's address
   * @param messagingKeyPair - User's derived messaging keypair
   * @param limit - Maximum number of transactions to fetch
   * @param afterRound - Only fetch messages after this round (for pagination)
   * @returns Array of decrypted messages sorted by timestamp
   */
  async fetchMessages(
    userAddress: string,
    friendAddress: string,
    messagingKeyPair: MessagingKeyPair,
    limit = 50,
    afterRound?: number
  ): Promise<Message[]> {
    const networkService = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    const indexer = networkService.getIndexerClient();

    // Fetch payment transactions for the user
    // We filter by friend address in the loop below
    let query = indexer
      .lookupAccountTransactions(userAddress)
      .txType('pay')
      .limit(limit);

    if (afterRound) {
      query = query.minRound(afterRound);
    }

    const response = await query.do();

    // Filter for transactions between user and friend
    const allTxns = (response.transactions || []).filter((txn: Record<string, unknown>) => {
      const receiver = (txn['payment-transaction'] as Record<string, unknown>)?.receiver ||
        (txn.paymentTransaction as Record<string, unknown>)?.receiver;
      // Include if user sent to friend OR friend sent to user
      return (
        (txn.sender === userAddress && receiver === friendAddress) ||
        (txn.sender === friendAddress && receiver === userAddress)
      );
    });

    const messages: Message[] = [];

    for (const txn of allTxns) {
      // Skip transactions without notes
      if (!txn.note) continue;

      // Get note as base64 string
      const noteBase64 =
        typeof txn.note === 'string'
          ? txn.note
          : Buffer.from(txn.note).toString('base64');

      // Try to parse as message note (v1 or v2)
      const parsed = parseMessageNoteAny(noteBase64);
      if (!parsed) continue;

      // Only process v2 messages
      if (parsed.version !== 2) {
        console.warn(`Skipping v1 message ${txn.id} - v1 format not supported`);
        continue;
      }

      const payload = parsed.payload;

      // Determine direction based on sender
      const direction: MessageDirection =
        txn.sender === userAddress ? 'sent' : 'received';

      // Verify sender matches payload public key
      if (!verifySender(txn.sender, payload)) {
        console.warn(`Sender verification failed for transaction ${txn.id}`);
        continue;
      }

      try {
        // Decrypt the message using v2 decryption
        const content = decryptMessageV2(payload, messagingKeyPair.secretKey);

        // Convert BigInt values to numbers for JSON serialization
        const confirmedRound = txn.confirmedRound
          ? typeof txn.confirmedRound === 'bigint'
            ? Number(txn.confirmedRound)
            : txn.confirmedRound
          : undefined;
        const fee = txn.fee
          ? typeof txn.fee === 'bigint'
            ? Number(txn.fee)
            : txn.fee
          : MESSAGE_FEE_MICRO;

        messages.push({
          id: txn.id,
          threadId: friendAddress,
          direction,
          content,
          timestamp: txn.roundTime ? txn.roundTime * 1000 : payload.t,
          status: 'confirmed',
          confirmedRound,
          fee,
        });
      } catch (error) {
        // Log but skip messages that fail to decrypt
        console.warn(`Failed to decrypt message ${txn.id}:`, error);
      }
    }

    // Sort by timestamp (oldest first for chat display)
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Fetch all conversations (messages grouped by conversation partner).
   *
   * @param userAddress - Current user's address
   * @param messagingKeyPair - User's derived messaging keypair
   * @param limit - Maximum number of transactions to fetch (increased to 500 to better discover messages from unknown senders)
   * @returns Map of friend address to array of messages
   */
  async fetchAllConversations(
    userAddress: string,
    messagingKeyPair: MessagingKeyPair,
    limit = 500
  ): Promise<Map<string, Message[]>> {
    const networkService = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    const indexer = networkService.getIndexerClient();

    // Fetch all recent payment transactions for the user
    const response = await indexer
      .lookupAccountTransactions(userAddress)
      .txType('pay')
      .limit(limit)
      .do();

    const conversationMap = new Map<string, Message[]>();

    for (const txn of response.transactions || []) {
      // Skip transactions without notes
      if (!txn.note) continue;

      // Get note as base64 string
      const noteBase64 =
        typeof txn.note === 'string'
          ? txn.note
          : Buffer.from(txn.note).toString('base64');

      // Try to parse as message note (v1 or v2)
      const parsed = parseMessageNoteAny(noteBase64);
      if (!parsed) continue;

      // Only process v2 messages
      if (parsed.version !== 2) continue;

      const payload = parsed.payload;

      // Determine direction and friend address
      const direction: MessageDirection =
        txn.sender === userAddress ? 'sent' : 'received';

      // Get the friend address (the other party)
      let friendAddress: string;
      if (direction === 'sent') {
        // For sent messages, friend is the receiver
        friendAddress = txn['payment-transaction']?.receiver ||
          txn.paymentTransaction?.receiver ||
          txn.receiver;
      } else {
        // For received messages, friend is the sender
        friendAddress = txn.sender;
      }

      if (!friendAddress) continue;

      // Verify sender matches payload public key
      if (!verifySender(txn.sender, payload)) {
        continue;
      }

      try {
        // Decrypt the message using v2 decryption
        const content = decryptMessageV2(payload, messagingKeyPair.secretKey);

        // Convert BigInt values to numbers for JSON serialization
        const confirmedRound = txn.confirmedRound
          ? typeof txn.confirmedRound === 'bigint'
            ? Number(txn.confirmedRound)
            : txn.confirmedRound
          : undefined;
        const fee = txn.fee
          ? typeof txn.fee === 'bigint'
            ? Number(txn.fee)
            : txn.fee
          : MESSAGE_FEE_MICRO;

        const message: Message = {
          id: txn.id,
          threadId: friendAddress,
          direction,
          content,
          timestamp: txn.roundTime ? txn.roundTime * 1000 : payload.t,
          status: 'confirmed',
          confirmedRound,
          fee,
        };

        // Add to conversation map
        const existing = conversationMap.get(friendAddress) || [];
        existing.push(message);
        conversationMap.set(friendAddress, existing);
      } catch {
        // Skip messages that fail to decrypt
      }
    }

    // Sort messages in each conversation by timestamp
    for (const [addr, msgs] of conversationMap) {
      conversationMap.set(addr, msgs.sort((a, b) => a.timestamp - b.timestamp));
    }

    return conversationMap;
  }

  /**
   * Check if a transaction note is a valid message note.
   *
   * @param noteBase64 - Base64-encoded note string
   * @returns true if the note is a valid message note
   */
  isMessageTransaction(noteBase64: string): boolean {
    return parseMessageNoteAny(noteBase64) !== null;
  }

  /**
   * Derive the messaging keypair for an account.
   * For software wallets, this happens automatically without user interaction.
   *
   * @param accountAddress - Account address
   * @param pin - Optional PIN for key access
   * @returns Derived messaging keypair
   */
  async deriveMessagingKeyPair(
    accountAddress: string,
    pin?: string
  ): Promise<MessagingKeyPair> {
    // Check cache first
    const cached = getCachedKeyPair(accountAddress);
    if (cached) {
      return cached;
    }

    // Get the wallet and account
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const account = wallet.accounts.find((acc) => acc.address === accountAddress);
    if (!account) {
      throw new Error('Account not found');
    }

    // Get the private key and derive messaging keypair
    const privateKey = await AccountSecureStorage.getPrivateKey(account.id, pin);

    try {
      return deriveMessagingKeyPairFromSecret(privateKey, accountAddress);
    } finally {
      privateKey.fill(0);
    }
  }

  /**
   * Check if an account has registered their messaging key on-chain.
   *
   * @param address - Address to check
   * @returns true if registered
   */
  async isKeyRegistered(address: string): Promise<boolean> {
    return isMessagingKeyRegistered(address);
  }

  /**
   * Register the messaging public key on-chain for an account.
   *
   * @param accountAddress - Account to register
   * @param pin - Optional PIN for transaction signing
   * @returns Transaction ID
   */
  async registerKey(accountAddress: string, pin?: string): Promise<string> {
    // Get the wallet and account
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const account = wallet.accounts.find((acc) => acc.address === accountAddress);
    if (!account) {
      throw new Error('Account not found');
    }

    // Derive the messaging keypair
    const messagingKeyPair = await this.deriveMessagingKeyPair(accountAddress, pin);

    // Register on-chain
    return registerMessagingKey(messagingKeyPair.publicKey, account as WalletAccount, pin);
  }

  /**
   * Look up a user's messaging public key.
   *
   * @param address - Address to look up
   * @returns Messaging key registration or null
   */
  async lookupKey(address: string) {
    return lookupMessagingKey(address);
  }

  /**
   * Clear cached messaging keys (call on logout or app background).
   *
   * @param address - Optional specific address to clear, or all if not specified
   */
  clearKeyCache(address?: string): void {
    if (address) {
      clearCachedKey(address);
    } else {
      clearAllCachedKeys();
    }
  }
}

// Export singleton instance
export default MessagingService.getInstance();

// Re-export types and utilities for convenience
export * from './types';
export {
  encryptMessageV2,
  decryptMessageV2,
  createMessageNoteV2,
  parseMessageNoteAny,
  verifySender,
  extractPublicKeyFromSecret,
} from './crypto';
export {
  deriveMessagingKeyPairFromSecret,
  deriveMessagingKeyPairWithSign,
  getCachedKeyPair,
  clearCachedKey,
  clearAllCachedKeys,
} from './keyDerivation';
export {
  lookupMessagingKey,
  registerMessagingKey,
  isMessagingKeyRegistered,
  getMessagingPublicKey,
} from './keyRegistry';

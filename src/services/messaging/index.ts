/**
 * Messaging Service
 *
 * High-level service for sending and receiving E2E encrypted messages
 * using blockchain transaction notes.
 *
 * V2: Uses signature-derived encryption for hardware wallet compatibility
 * and improved security (private key never directly used in ECDH).
 *
 * Message fetching uses MIMIR (voiwallet.messages table) for efficient queries,
 * with fallback to indexer if MIMIR is unavailable.
 */

import { NetworkService } from '@/services/network';
import { TransactionService, TransactionParams } from '@/services/transactions';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { getSupabaseClient } from '@/services/supabase';
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

/**
 * MIMIR messages table row structure
 */
interface MimirMessage {
  id: number;
  sender: string;
  receiver: string;
  txid: string;
  round: number;
  intra: number;
  timestamp: number;
  version: number;
  note: string;
  created_at: string;
}
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

    // Verify sender has registered their messaging key (defense in depth)
    const senderRegistered = await isMessagingKeyRegistered(request.senderAddress);
    if (!senderRegistered) {
      throw new Error(
        'You must register for encrypted messaging before sending messages. Please enable messaging first.'
      );
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
   * Uses MIMIR (voiwallet.messages table) for efficient queries,
   * with fallback to indexer if MIMIR is unavailable.
   *
   * @param userAddress - Current user's address
   * @param friendAddress - Friend's address
   * @param messagingKeyPair - User's derived messaging keypair
   * @param limit - Maximum number of messages to fetch
   * @param afterRound - Only fetch messages after this round (for polling new messages)
   * @param beforeRound - Only fetch messages before this round (for loading older messages)
   * @returns Array of decrypted messages sorted by timestamp
   */
  async fetchMessages(
    userAddress: string,
    friendAddress: string,
    messagingKeyPair: MessagingKeyPair,
    limit = 50,
    afterRound?: number,
    beforeRound?: number
  ): Promise<Message[]> {
    const supabase = getSupabaseClient();

    // Try MIMIR first if Supabase is configured
    if (supabase) {
      try {
        const mimirMessages = await this.fetchMessagesFromMimir(
          userAddress,
          friendAddress,
          limit,
          afterRound,
          beforeRound
        );

        return this.decryptMimirMessages(
          mimirMessages,
          userAddress,
          friendAddress,
          messagingKeyPair
        );
      } catch (error) {
        console.warn('MIMIR fetch failed, falling back to indexer:', error);
      }
    }

    // Fallback to indexer
    return this.fetchMessagesFromIndexer(
      userAddress,
      friendAddress,
      messagingKeyPair,
      limit,
      afterRound,
      beforeRound
    );
  }

  /**
   * Fetch messages from MIMIR (voiwallet.messages table)
   */
  private async fetchMessagesFromMimir(
    userAddress: string,
    friendAddress: string,
    limit: number,
    afterRound?: number,
    beforeRound?: number
  ): Promise<MimirMessage[]> {
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error('Supabase not configured');
    }

    // Build query for messages between user and friend (bidirectional) from voiwallet schema
    let query = supabase
      .schema('voiwallet')
      .from('messages')
      .select('*')
      .or(
        `and(sender.eq.${userAddress},receiver.eq.${friendAddress}),` +
        `and(sender.eq.${friendAddress},receiver.eq.${userAddress})`
      )
      .order('round', { ascending: false })
      .limit(limit);

    if (afterRound) {
      query = query.gt('round', afterRound);
    }

    if (beforeRound) {
      query = query.lt('round', beforeRound);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`MIMIR query failed: ${error.message}`);
    }

    return (data as MimirMessage[]) || [];
  }

  /**
   * Decrypt messages fetched from MIMIR
   */
  private decryptMimirMessages(
    mimirMessages: MimirMessage[],
    userAddress: string,
    friendAddress: string,
    messagingKeyPair: MessagingKeyPair
  ): Message[] {
    const messages: Message[] = [];

    for (const msg of mimirMessages) {
      // Only process v2 messages
      if (msg.version !== 2) {
        console.warn(`Skipping v1 message ${msg.txid} - v1 format not supported`);
        continue;
      }

      // The note in MIMIR is already decoded (UTF-8 string)
      // We need to convert it back to base64 for parseMessageNoteAny
      const noteBase64 = Buffer.from(msg.note).toString('base64');
      const parsed = parseMessageNoteAny(noteBase64);
      if (!parsed || parsed.version !== 2) {
        continue;
      }

      const payload = parsed.payload;
      const direction: MessageDirection =
        msg.sender === userAddress ? 'sent' : 'received';

      // Verify sender matches payload public key
      if (!verifySender(msg.sender, payload)) {
        console.warn(`Sender verification failed for message ${msg.txid}`);
        continue;
      }

      try {
        const content = decryptMessageV2(payload, messagingKeyPair.secretKey);

        messages.push({
          id: msg.txid,
          threadId: friendAddress,
          direction,
          content,
          timestamp: msg.timestamp * 1000, // Convert seconds to ms
          status: 'confirmed',
          confirmedRound: msg.round,
          fee: MESSAGE_FEE_MICRO,
        });
      } catch (error) {
        console.warn(`Failed to decrypt message ${msg.txid}:`, error);
      }
    }

    // Sort by timestamp (oldest first for chat display)
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Fetch messages from indexer (fallback method)
   */
  private async fetchMessagesFromIndexer(
    userAddress: string,
    friendAddress: string,
    messagingKeyPair: MessagingKeyPair,
    limit: number,
    afterRound?: number,
    beforeRound?: number
  ): Promise<Message[]> {
    const networkService = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    const indexer = networkService.getIndexerClient();

    // Fetch payment transactions for the user
    let query = indexer
      .lookupAccountTransactions(userAddress)
      .txType('pay')
      .limit(limit);

    if (afterRound) {
      query = query.minRound(afterRound);
    }

    if (beforeRound) {
      query = query.maxRound(beforeRound - 1);
    }

    const response = await query.do();

    // Filter for transactions between user and friend
    const allTxns = (response.transactions || []).filter((txn: Record<string, unknown>) => {
      const receiver = (txn['payment-transaction'] as Record<string, unknown>)?.receiver ||
        (txn.paymentTransaction as Record<string, unknown>)?.receiver;
      return (
        (txn.sender === userAddress && receiver === friendAddress) ||
        (txn.sender === friendAddress && receiver === userAddress)
      );
    });

    const messages: Message[] = [];

    for (const txn of allTxns) {
      if (!txn.note) continue;

      const noteBase64 =
        typeof txn.note === 'string'
          ? txn.note
          : Buffer.from(txn.note).toString('base64');

      const parsed = parseMessageNoteAny(noteBase64);
      if (!parsed) continue;

      if (parsed.version !== 2) {
        console.warn(`Skipping v1 message ${txn.id} - v1 format not supported`);
        continue;
      }

      const payload = parsed.payload;
      const direction: MessageDirection =
        txn.sender === userAddress ? 'sent' : 'received';

      if (!verifySender(txn.sender, payload)) {
        console.warn(`Sender verification failed for transaction ${txn.id}`);
        continue;
      }

      try {
        const content = decryptMessageV2(payload, messagingKeyPair.secretKey);

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
        console.warn(`Failed to decrypt message ${txn.id}:`, error);
      }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Fetch all conversations (messages grouped by conversation partner).
   *
   * Uses MIMIR (voiwallet.messages table) for efficient queries,
   * with fallback to indexer if MIMIR is unavailable.
   *
   * @param userAddress - Current user's address
   * @param messagingKeyPair - User's derived messaging keypair
   * @param limit - Maximum number of messages to fetch
   * @param afterRound - Only fetch messages after this round (for incremental sync)
   * @returns Map of friend address to array of messages
   */
  async fetchAllConversations(
    userAddress: string,
    messagingKeyPair: MessagingKeyPair,
    limit = 100,
    afterRound?: number
  ): Promise<Map<string, Message[]>> {
    const supabase = getSupabaseClient();

    // Try MIMIR first if Supabase is configured
    if (supabase) {
      try {
        const mimirMessages = await this.fetchAllConversationsFromMimir(
          userAddress,
          limit,
          afterRound
        );

        return this.groupAndDecryptMimirMessages(
          mimirMessages,
          userAddress,
          messagingKeyPair
        );
      } catch (error) {
        console.warn('MIMIR fetch failed, falling back to indexer:', error);
      }
    }

    // Fallback to indexer
    return this.fetchAllConversationsFromIndexer(
      userAddress,
      messagingKeyPair,
      limit,
      afterRound
    );
  }

  /**
   * Fetch all conversations from MIMIR
   */
  private async fetchAllConversationsFromMimir(
    userAddress: string,
    limit: number,
    afterRound?: number
  ): Promise<MimirMessage[]> {
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error('Supabase not configured');
    }

    // Query all messages where user is sender or receiver from voiwallet schema
    let query = supabase
      .schema('voiwallet')
      .from('messages')
      .select('*')
      .or(`sender.eq.${userAddress},receiver.eq.${userAddress}`)
      .order('round', { ascending: false })
      .limit(limit);

    if (afterRound) {
      query = query.gt('round', afterRound);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`MIMIR query failed: ${error.message}`);
    }

    return (data as MimirMessage[]) || [];
  }

  /**
   * Group and decrypt messages from MIMIR into conversations
   */
  private groupAndDecryptMimirMessages(
    mimirMessages: MimirMessage[],
    userAddress: string,
    messagingKeyPair: MessagingKeyPair
  ): Map<string, Message[]> {
    const conversationMap = new Map<string, Message[]>();

    for (const msg of mimirMessages) {
      // Only process v2 messages
      if (msg.version !== 2) continue;

      // Determine friend address (the other party)
      const friendAddress = msg.sender === userAddress ? msg.receiver : msg.sender;
      const direction: MessageDirection =
        msg.sender === userAddress ? 'sent' : 'received';

      // Parse and verify the message
      const noteBase64 = Buffer.from(msg.note).toString('base64');
      const parsed = parseMessageNoteAny(noteBase64);
      if (!parsed || parsed.version !== 2) continue;

      if (!verifySender(msg.sender, parsed.payload)) continue;

      try {
        const content = decryptMessageV2(parsed.payload, messagingKeyPair.secretKey);

        const message: Message = {
          id: msg.txid,
          threadId: friendAddress,
          direction,
          content,
          timestamp: msg.timestamp * 1000, // Convert seconds to ms
          status: 'confirmed',
          confirmedRound: msg.round,
          fee: MESSAGE_FEE_MICRO,
        };

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
   * Fetch all conversations from indexer (fallback method)
   */
  private async fetchAllConversationsFromIndexer(
    userAddress: string,
    messagingKeyPair: MessagingKeyPair,
    limit: number,
    afterRound?: number
  ): Promise<Map<string, Message[]>> {
    const networkService = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    const indexer = networkService.getIndexerClient();

    let query = indexer
      .lookupAccountTransactions(userAddress)
      .txType('pay')
      .limit(limit);

    if (afterRound) {
      query = query.minRound(afterRound);
    }

    const response = await query.do();

    const conversationMap = new Map<string, Message[]>();

    for (const txn of response.transactions || []) {
      if (!txn.note) continue;

      const noteBase64 =
        typeof txn.note === 'string'
          ? txn.note
          : Buffer.from(txn.note).toString('base64');

      const parsed = parseMessageNoteAny(noteBase64);
      if (!parsed || parsed.version !== 2) continue;

      const payload = parsed.payload;
      const direction: MessageDirection =
        txn.sender === userAddress ? 'sent' : 'received';

      let friendAddress: string;
      if (direction === 'sent') {
        friendAddress = txn['payment-transaction']?.receiver ||
          txn.paymentTransaction?.receiver ||
          txn.receiver;
      } else {
        friendAddress = txn.sender;
      }

      if (!friendAddress) continue;
      if (!verifySender(txn.sender, payload)) continue;

      try {
        const content = decryptMessageV2(payload, messagingKeyPair.secretKey);

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

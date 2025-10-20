import {
  TransactionService,
  TransactionParams,
  UnsignedTransaction,
  UnsignedTransactionGroup,
  SignProgressCallbacks,
} from '@/services/transactions';
import { WalletAccount } from '@/types/wallet';

/**
 * Secure Transaction Manager - Handles PIN collection and secure transaction processing
 */

export class SecureTransactionManager {
  /**
   * Send transaction with PIN verification integrated
   * Now supports VOI, ASA, and ARC-200 transactions
   */
  static async sendTransactionWithPin(
    params: TransactionParams,
    account: WalletAccount,
    pin?: string,
    callbacks?: SignProgressCallbacks
  ): Promise<string> {
    try {
      // Validate transaction first
      const validationErrors = await TransactionService.validateTransaction(
        params,
        account
      );
      if (validationErrors.length > 0) {
        throw new Error(
          `Transaction validation failed: ${validationErrors.join(', ')}`
        );
      }

      // Send transaction using secure key access
      const txId = await TransactionService.sendTransaction(
        params,
        account,
        pin,
        callbacks
      );

      return txId;
    } catch (error) {
      throw new Error(
        `Secure transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Estimate transaction cost
   */
  static async estimateTransactionCost(params: TransactionParams) {
    return await TransactionService.estimateTransactionCost(params);
  }

  /**
   * Validate transaction without PIN
   */
  static async validateTransaction(
    params: TransactionParams,
    account: WalletAccount
  ) {
    return await TransactionService.validateTransaction(params, account);
  }
}

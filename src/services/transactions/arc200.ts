import algosdk from 'algosdk';
import VoiNetworkService, { NetworkService } from '@/services/network';
import MimirApiService from '@/services/mimir';

// ARC-200 transfer ABI definition
const ARC200_TRANSFER_ABI = {
  name: 'arc200_transfer',
  desc: 'Transfers tokens',
  readonly: false,
  args: [
    {
      type: 'address',
      name: 'to',
      desc: 'The destination of the transfer',
    },
    {
      type: 'uint256',
      name: 'value',
      desc: 'Amount of tokens to transfer',
    },
  ],
  returns: { type: 'bool', desc: 'Success' },
};

// Minimum Balance Requirement for ARC-200 opt-in (28500 microVOI)
const ARC200_MBR_AMOUNT = 28500;

export interface Arc200TransferParams {
  from: string;
  to: string;
  amount: number | bigint;
  contractId: number;
  note?: string;
  networkId?: string;
}

export interface Arc200TransactionGroup {
  transactions: algosdk.Transaction[];
  txnBytes: Uint8Array[];
  needsMbrPayment: boolean;
}

export class Arc200TransactionService {
  /**
   * Check if recipient has a balance > 0 for the ARC-200 token
   * If they do, no MBR payment is needed
   */
  static async checkRecipientBalance(
    recipientAddress: string,
    contractId: number,
    networkService?: any
  ): Promise<boolean> {
    try {
      // If address is invalid or placeholder, assume MBR is needed
      if (!recipientAddress || !algosdk.isValidAddress(recipientAddress)) {
        return false;
      }

      // Use network service if provided to get account balance (includes ARC-200)
      if (networkService) {
        const accountBalance = await networkService.getAccountBalance(recipientAddress);
        const arc200Asset = accountBalance.assets?.find(
          (asset: any) =>
            asset.assetType === 'arc200' && asset.contractId === contractId
        );
        return arc200Asset && parseFloat(arc200Asset.balance) > 0;
      }

      // Fallback to MimirApiService for backwards compatibility
      const assets =
        await MimirApiService.getAllAccountAssets(recipientAddress);

      // Find the specific ARC-200 token
      const arc200Asset = assets.find(
        (asset) =>
          asset.assetType === 'arc200' && asset.contractId === contractId
      );

      // If asset exists and has balance > 0, recipient is already opted in
      return arc200Asset && parseFloat(arc200Asset.balance) > 0;
    } catch (error) {
      // Silently assume MBR payment is needed if we can't check
      return false;
    }
  }

  /**
   * Build ARC-200 transfer transaction group
   * This creates an atomic transaction group with:
   * 1. Optional payment transaction for MBR (if recipient balance is 0)
   * 2. Application call transaction for arc200_transfer
   */
  static async buildArc200TransferGroup(
    params: Arc200TransferParams
  ): Promise<Arc200TransactionGroup> {
    try {
      // Use the networkId from params, or default to VoiNetworkService for backwards compatibility
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId as any)
        : VoiNetworkService;
      const suggestedParams = await networkService.getSuggestedParams();

      if (!algosdk.isValidAddress(params.from)) {
        throw new Error(`Invalid sender address: ${params.from}`);
      }

      if (!algosdk.isValidAddress(params.to)) {
        throw new Error(`Invalid recipient address: ${params.to}`);
      }

      if (typeof params.amount === 'number' && params.amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }

      if (typeof params.amount === 'bigint' && params.amount <= 0n) {
        throw new Error('Amount must be greater than 0');
      }

      const transactions: algosdk.Transaction[] = [];

      // Check if recipient needs MBR payment
      const hasBalance = await this.checkRecipientBalance(
        params.to,
        params.contractId,
        networkService
      );
      const needsMbrPayment = !hasBalance;

      // 1. Add MBR payment transaction if needed
      if (needsMbrPayment) {
        // MBR payment goes to the application escrow address, not the recipient
        const appEscrowAddress = algosdk.getApplicationAddress(
          params.contractId
        );

        const mbrPaymentTxn =
          algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            sender: params.from,
            receiver: appEscrowAddress,
            amount: ARC200_MBR_AMOUNT,
            note: params.note
              ? new Uint8Array(Buffer.from(`MBR for ARC-200: ${params.note}`))
              : new Uint8Array(Buffer.from('MBR for ARC-200 transfer')),
            suggestedParams,
          });
        transactions.push(mbrPaymentTxn);
      }

      // 2. Build ARC-200 transfer application call
      const arc200TransferTxn = await this.buildArc200TransferCall(
        params,
        suggestedParams,
        networkService
      );
      transactions.push(arc200TransferTxn);

      // 3. Create atomic transaction group if multiple transactions
      if (transactions.length > 1) {
        const groupId = algosdk.computeGroupID(transactions);
        transactions.forEach((txn) => (txn.group = groupId));
      }

      // 4. Encode transactions
      const txnBytes = transactions.map((txn) =>
        algosdk.encodeUnsignedTransaction(txn)
      );

      return {
        transactions,
        txnBytes,
        needsMbrPayment,
      };
    } catch (error) {
      console.error('Failed to build ARC-200 transfer group:', error);
      throw new Error(
        `ARC-200 transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Build the ARC-200 transfer application call transaction
   */
  private static async buildArc200TransferCall(
    params: Arc200TransferParams,
    suggestedParams: algosdk.SuggestedParams,
    networkService: any
  ): Promise<algosdk.Transaction> {
    try {
      // Validate the recipient address
      if (!algosdk.isValidAddress(params.to)) {
        throw new Error(`Invalid recipient address: ${params.to}`);
      }

      // Create ABI method for proper encoding
      const method = new algosdk.ABIMethod(ARC200_TRANSFER_ABI);

      // Convert amount to proper format for uint256
      const amountBigInt =
        typeof params.amount === 'bigint'
          ? params.amount
          : BigInt(params.amount);

      // Encode the method arguments properly
      const addressType = algosdk.ABIType.from('address');
      const uint256Type = algosdk.ABIType.from('uint256');

      // Build app args array with method selector and encoded arguments
      const appArgs = [
        method.getSelector(),
        addressType.encode(params.to),
        uint256Type.encode(amountBigInt),
      ];

      // Create suggested params without BigInt values for simulation
      const simulationParams = {
        ...suggestedParams,
        fee: Number(suggestedParams.fee),
        firstRound: Number(suggestedParams.firstRound),
        lastRound: Number(suggestedParams.lastRound),
        minFee: Number(suggestedParams.minFee),
      };

      // First, simulate the transaction to get the required box references
      const simulationTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: params.from,
        appIndex: params.contractId,
        appArgs: appArgs,
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams: simulationParams,
      });

      // Simulate the transaction to get box references
      const algodClient = networkService.getAlgodClient();

      // Create the simulation request using the correct algosdk format
      // First encode the transaction, then create a signed transaction for simulation
      const encodedTxn = algosdk.encodeUnsignedTransaction(simulationTxn);

      // Create a mock signed transaction with a 64-byte signature
      const mockSignedTxn = new algosdk.SignedTransaction({
        txn: simulationTxn,
        sig: new Uint8Array(64), // 64-byte signature filled with zeros
      });

      const simulateRequest = new algosdk.modelsv2.SimulateRequest({
        txnGroups: [
          new algosdk.modelsv2.SimulateRequestTransactionGroup({
            txns: [mockSignedTxn],
          }),
        ],
        allowEmptySignatures: true,
        allowMoreLogging: true,
        allowUnnamedResources: true,
      });

      let boxes: Array<{ appIndex: number; name: Uint8Array }> = [];

      try {
        const simulateResponse = await algodClient
          .simulateTransactions(simulateRequest)
          .do();

        // Extract box references from simulation
        const unnamedResources =
          simulateResponse.txnGroups?.[0]?.unnamedResourcesAccessed;
        const txnBoxes =
          simulateResponse.txnGroups?.[0]?.txnResults?.[0]
            ?.unnamedResourcesAccessed?.boxes;

        if (unnamedResources?.boxes || txnBoxes) {
          const allBoxes = [
            ...(unnamedResources?.boxes || []),
            ...(txnBoxes || []),
          ];

          // Convert simulation box references to transaction format
          // Handle both BigInt and number for app field
          boxes = allBoxes
            .filter((box) => Number(box.app) === params.contractId)
            .map((box) => ({
              appIndex: Number(box.app), // Convert BigInt to number
              name: new Uint8Array(box.name),
            }));
        }
      } catch (error) {
        console.error('Failed to simulate ARC-200 transaction:', error);
        throw error;
      }

      // Build the application call transaction with box references from simulation
      const appCallTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: params.from,
        appIndex: params.contractId,
        appArgs: appArgs,
        boxes: boxes,
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams,
      });

      return appCallTxn;
    } catch (error) {
      console.error('Failed to build ARC-200 application call:', error);
      throw new Error(
        `ARC-200 app call build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Estimate the total cost of an ARC-200 transfer
   * This includes the app call fee and potentially MBR payment
   */
  static async estimateArc200TransferCost(
    params: Arc200TransferParams
  ): Promise<{
    fee: number;
    mbrAmount: number;
    total: number;
    needsMbrPayment: boolean;
  }> {
    try {
      // Use the networkId from params, or default to VoiNetworkService for backwards compatibility
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId as any)
        : VoiNetworkService;

      const baseFee = await networkService.estimateTransactionFee();
      const hasBalance = await this.checkRecipientBalance(
        params.to,
        params.contractId,
        networkService
      );
      const needsMbrPayment = !hasBalance;

      // For atomic groups, each transaction has a fee
      const totalFee = needsMbrPayment ? baseFee * 2 : baseFee;
      const mbrAmount = needsMbrPayment ? ARC200_MBR_AMOUNT : 0;
      const total = totalFee + mbrAmount;

      return {
        fee: total, // Return total (including MBR) as the fee
        mbrAmount,
        total,
        needsMbrPayment,
      };
    } catch (error) {
      console.error('Failed to estimate ARC-200 transfer cost:', error);
      throw new Error(
        `ARC-200 cost estimation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

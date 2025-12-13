import algosdk from 'algosdk';
import VoiNetworkService, { NetworkService } from '@/services/network';
import MimirApiService from '@/services/mimir';

// ARC-72 transfer ABI definition
const ARC72_TRANSFER_FROM_ABI = {
  name: 'arc72_transferFrom',
  desc: 'Transfers NFT from one address to another',
  readonly: false,
  args: [
    {
      type: 'address',
      name: 'from',
      desc: 'The current owner of the NFT',
    },
    {
      type: 'address',
      name: 'to',
      desc: 'The destination of the transfer',
    },
    {
      type: 'uint256',
      name: 'tokenId',
      desc: 'The NFT token ID to transfer',
    },
  ],
  returns: { type: 'void', desc: 'No return value' },
};

// Minimum Balance Requirement for ARC-72 opt-in (28500 microVOI)
const ARC72_MBR_AMOUNT = 28500;

export interface Arc72TransferParams {
  from: string;
  to: string;
  tokenId: string;
  contractId: number;
  note?: string;
  networkId?: string;
}

export interface Arc72TransactionGroup {
  transactions: algosdk.Transaction[];
  txnBytes: Uint8Array[];
  needsMbrPayment: boolean;
}

export class Arc72TransactionService {
  /**
   * Check if recipient has any ARC-72 tokens for the contract
   * If they do, no MBR payment is needed
   */
  static async checkRecipientBalance(
    recipientAddress: string,
    contractId: number,
    networkService?: any
  ): Promise<boolean> {
    try {
      // Use network service if provided to get account balance (includes ARC-72)
      if (networkService) {
        const accountBalance = await networkService.getAccountBalance(recipientAddress);
        const arc72Asset = accountBalance.assets?.find(
          (asset: any) =>
            asset.assetType === 'arc72' && asset.contractId === contractId
        );
        return !!arc72Asset;
      }

      // Fallback to MimirApiService for backwards compatibility
      const assets =
        await MimirApiService.getAllAccountAssets(recipientAddress);

      // Find any ARC-72 token for this contract
      const arc72Asset = assets.find(
        (asset) =>
          asset.assetType === 'arc72' && asset.contractId === contractId
      );

      // If any ARC-72 token exists for this contract, recipient is already opted in
      return !!arc72Asset;
    } catch (error) {
      console.warn(
        'Failed to check recipient balance, assuming MBR payment needed:',
        error
      );
      // If we can't check, assume MBR payment is needed for safety
      return false;
    }
  }

  /**
   * Build ARC-72 transfer transaction group
   * This creates an atomic transaction group with:
   * 1. Optional payment transaction for MBR (if recipient has no tokens from this contract)
   * 2. Application call transaction for arc72_transferFrom
   */
  static async buildArc72TransferGroup(
    params: Arc72TransferParams
  ): Promise<Arc72TransactionGroup> {
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

      if (!params.tokenId) {
        throw new Error('Token ID is required');
      }

      const transactions: algosdk.Transaction[] = [];

      // Check if recipient needs MBR payment
      const hasTokens = await this.checkRecipientBalance(
        params.to,
        params.contractId,
        networkService
      );
      const needsMbrPayment = !hasTokens;

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
            amount: ARC72_MBR_AMOUNT,
            note: params.note
              ? new Uint8Array(Buffer.from(`MBR for ARC-72: ${params.note}`))
              : new Uint8Array(Buffer.from('MBR for ARC-72 transfer')),
            suggestedParams,
          });
        transactions.push(mbrPaymentTxn);
      }

      // 2. Build ARC-72 transfer application call
      const arc72TransferTxn = await this.buildArc72TransferCall(
        params,
        suggestedParams,
        networkService
      );
      transactions.push(arc72TransferTxn);

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
      console.error('Failed to build ARC-72 transfer group:', error);
      throw new Error(
        `ARC-72 transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Build the ARC-72 transfer application call transaction
   */
  private static async buildArc72TransferCall(
    params: Arc72TransferParams,
    suggestedParams: algosdk.SuggestedParams,
    networkService: any
  ): Promise<algosdk.Transaction> {
    try {
      // Validate the recipient address
      if (!algosdk.isValidAddress(params.to)) {
        throw new Error(`Invalid recipient address: ${params.to}`);
      }

      // Create ABI method for proper encoding
      const method = new algosdk.ABIMethod(ARC72_TRANSFER_FROM_ABI);

      // Convert tokenId to proper format for uint256
      const tokenIdBigInt = BigInt(params.tokenId);

      // Encode the method arguments properly
      const addressType = algosdk.ABIType.from('address');
      const uint256Type = algosdk.ABIType.from('uint256');

      // Build app args array with method selector and encoded arguments
      const appArgs = [
        method.getSelector(),
        addressType.encode(params.from),
        addressType.encode(params.to),
        uint256Type.encode(tokenIdBigInt),
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
        fixSigners: true,
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
        console.error('Failed to simulate ARC-72 transaction:', error);
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
      console.error('Failed to build ARC-72 application call:', error);
      throw new Error(
        `ARC-72 app call build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Estimate the total cost of an ARC-72 transfer
   * This includes the app call fee and potentially MBR payment
   */
  static async estimateArc72TransferCost(
    params: Arc72TransferParams
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
      const hasTokens = await this.checkRecipientBalance(
        params.to,
        params.contractId,
        networkService
      );
      const needsMbrPayment = !hasTokens;

      // For atomic groups, each transaction has a fee
      const totalFee = needsMbrPayment ? baseFee * 2 : baseFee;
      const mbrAmount = needsMbrPayment ? ARC72_MBR_AMOUNT : 0;
      const total = totalFee + mbrAmount;

      return {
        fee: totalFee,
        mbrAmount,
        total,
        needsMbrPayment,
      };
    } catch (error) {
      console.error('Failed to estimate ARC-72 transfer cost:', error);
      throw new Error(
        `ARC-72 cost estimation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
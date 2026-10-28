import algosdk from 'algosdk';
import {
  networkService as defaultNetworkService,
  NetworkService,
} from '@/services/network';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { MultiAccountWalletService } from '@/services/wallet';
import { checkRemoteSigningRequired } from '@/services/remoteSigner/signingRouter';
import { NetworkId } from '@/types/network';
import { redactError } from '@/utils/logRedaction';

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

// ARC-200 transferFrom ABI definition (for claiming approved tokens)
const ARC200_TRANSFER_FROM_ABI = {
  name: 'arc200_transferFrom',
  desc: 'Transfers tokens from one address to another using approval',
  readonly: false,
  args: [
    {
      type: 'address',
      name: 'from',
      desc: 'The source address (token owner)',
    },
    {
      type: 'address',
      name: 'to',
      desc: 'The destination address',
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
  forceMbrPayment?: boolean;
  networkId?: string;
}

export interface Arc200TransactionGroup {
  transactions: algosdk.Transaction[];
  txnBytes: Uint8Array[];
  needsMbrPayment: boolean;
}

export interface Arc200TransferFromParams {
  /** ARC-200 contract ID */
  contractId: number;
  /** Token owner address (from whom tokens will be transferred) */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount to transfer in base units */
  amount: bigint;
  /** Address of the spender executing the transfer (the claimer) */
  sender: string;
  /** Optional note */
  note?: string;
  /** Force funding when rebuilding after a submit race. */
  forceMbrPayment?: boolean;
  /** Network ID */
  networkId?: string;
}

export interface Arc200ClaimParams {
  contractId: number;
  from: string;
  to: string;
  amount: bigint;
  sender: string;
}

export class Arc200TransactionService {
  private static async requiresMbr(
    sender: string,
    simulated: boolean,
    force = false,
    networkId?: string
  ) {
    if (force || !simulated) return true;
    try {
      const accounts = await MultiAccountWalletService.getAllAccounts();
      const info = await SecureKeyManager.getSigningInfo(
        sender,
        networkId as NetworkId
      );
      const account = accounts.find((a) => a.address === sender);
      const signer = accounts.find((a) => a.address === info.signingAddress);
      if (!account || !signer) return true;
      return (
        checkRemoteSigningRequired(account).needsRemoteSigning ||
        checkRemoteSigningRequired(signer).needsRemoteSigning
      );
    } catch {
      return true;
    }
  }

  private static async simulateTransfer(
    request: algosdk.modelsv2.SimulateRequest,
    transaction: algosdk.Transaction,
    suggestedParams: algosdk.SuggestedParams,
    contractId: number,
    networkService: NetworkService
  ) {
    const simulate = async (txns: algosdk.Transaction[]) => {
      request.txnGroups[0].txns = txns.map(
        (txn) => new algosdk.SignedTransaction({ txn, sig: new Uint8Array(64) })
      );
      return networkService.getAlgodClient().simulateTransactions(request).do();
    };
    let group;
    let simulated = false;
    try {
      const response = await simulate([transaction]);
      group = response.txnGroups?.[0];
      // Success can also mean the contract's escrow surplus covered a new box.
      // That is acceptable because the contract accepts the transfer as-is.
      simulated =
        !!group &&
        !group.failureMessage &&
        group.txnResults?.length === 1 &&
        group.txnResults.every(
          (result) => !!result.txnResult && !result.txnResult.poolError
        );
    } catch {
      // Any simulation error keeps the MBR payment (fail-safe overpay).
    }
    if (!simulated) {
      const payment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: transaction.sender,
        receiver: algosdk.getApplicationAddress(contractId),
        amount: ARC200_MBR_AMOUNT,
        suggestedParams,
      });
      const funded = [payment, transaction];
      algosdk.assignGroupID(funded);
      try {
        // Discover resources with funding, without changing the MBR decision.
        group = (await simulate(funded)).txnGroups?.[0];
      } catch {
        // Keep any resources discovered by the first attempt.
      }
    }
    return { response: { txnGroups: group ? [group] : [] }, simulated };
  }

  static groupCost(group: Arc200TransactionGroup): number {
    return group.transactions.reduce(
      (cost, txn) =>
        cost +
        Number(txn.fee) +
        (txn.type === algosdk.TransactionType.pay
          ? Number(txn.payment!.amount)
          : 0),
      0
    );
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
      // Use the networkId from params, or default to defaultNetworkService for backwards compatibility
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId as any)
        : defaultNetworkService;
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

      const { transaction: arc200TransferTxn, simulated } =
        await this.buildArc200TransferCall(
          params,
          suggestedParams,
          networkService
        );
      const needsMbrPayment = await this.requiresMbr(
        params.from,
        simulated,
        params.forceMbrPayment,
        params.networkId
      );

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
      console.error(
        'Failed to build ARC-200 transfer group:',
        redactError(error)
      );
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
  ): Promise<{ transaction: algosdk.Transaction; simulated: boolean }> {
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

      // Create a mock signed transaction with a 64-byte signature
      const mockSignedTxn = new algosdk.SignedTransaction({
        txn: simulationTxn,
        sig: new Uint8Array(64),
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
        fixSigners: true, // Automatically resolve signers for rekeyed accounts
      });

      let simulated = false;
      let boxes: { appIndex: number; name: Uint8Array }[] = [];

      try {
        const result = await this.simulateTransfer(
          simulateRequest,
          simulationTxn,
          simulationParams,
          params.contractId,
          networkService
        );
        const simulateResponse = result.response;
        simulated = result.simulated;

        // Extract box references from simulation
        const unnamedResources =
          simulateResponse.txnGroups?.[0]?.unnamedResourcesAccessed;
        const txnBoxes =
          simulateResponse.txnGroups?.[0]?.txnResults?.at(-1)
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
        console.error(
          'Failed to simulate ARC-200 transaction:',
          redactError(error)
        );
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

      return { transaction: appCallTxn, simulated };
    } catch (error) {
      console.error(
        'Failed to build ARC-200 application call:',
        redactError(error)
      );
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
      const group = await this.buildArc200TransferGroup(params);
      const needsMbrPayment = group.needsMbrPayment;
      const mbrAmount = needsMbrPayment ? ARC200_MBR_AMOUNT : 0;
      const total = this.groupCost(group);

      return {
        fee: total, // Return total (including MBR) as the fee
        mbrAmount,
        total,
        needsMbrPayment,
      };
    } catch (error) {
      console.error(
        'Failed to estimate ARC-200 transfer cost:',
        redactError(error)
      );
      throw new Error(
        `ARC-200 cost estimation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ============================================================================
  // TransferFrom methods for claiming approved tokens
  // ============================================================================

  /**
   * Build ARC-200 transferFrom transaction group for claiming approved tokens
   * This creates an atomic transaction group with:
   * 1. Optional payment transaction for MBR (if recipient balance is 0)
   * 2. Application call transaction for arc200_transferFrom
   */
  static async buildArc200TransferFromGroup(
    params: Arc200TransferFromParams
  ): Promise<Arc200TransactionGroup> {
    // TASK-397: identical bytes for repeated single claims in one validity
    // window are deliberate. The chain's txid dedupe stops a retry or double
    // tap from claiming the allowance twice; a nonce note removes that protection.
    try {
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId as any)
        : defaultNetworkService;
      const suggestedParams = await networkService.getSuggestedParams();

      if (!algosdk.isValidAddress(params.from)) {
        throw new Error(`Invalid owner address: ${params.from}`);
      }

      if (!algosdk.isValidAddress(params.to)) {
        throw new Error(`Invalid recipient address: ${params.to}`);
      }

      if (!algosdk.isValidAddress(params.sender)) {
        throw new Error(`Invalid sender address: ${params.sender}`);
      }

      if (params.amount <= 0n) {
        throw new Error('Amount must be greater than 0');
      }

      const transactions: algosdk.Transaction[] = [];

      const { transaction: transferFromTxn, simulated } =
        await this.buildArc200TransferFromCall(
          params,
          suggestedParams,
          networkService
        );
      const needsMbrPayment = await this.requiresMbr(
        params.sender,
        simulated,
        params.forceMbrPayment,
        params.networkId
      );

      // 1. Add MBR payment transaction if needed
      if (needsMbrPayment) {
        const appEscrowAddress = algosdk.getApplicationAddress(
          params.contractId
        );

        const mbrPaymentTxn =
          algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            sender: params.sender,
            receiver: appEscrowAddress,
            amount: ARC200_MBR_AMOUNT,
            note: new Uint8Array(Buffer.from('MBR for ARC-200 claim')),
            suggestedParams,
          });
        transactions.push(mbrPaymentTxn);
      }

      // 2. Build ARC-200 transferFrom application call
      transactions.push(transferFromTxn);

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
      console.error(
        'Failed to build ARC-200 transferFrom group:',
        redactError(error)
      );
      throw new Error(
        `ARC-200 transferFrom build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Build the ARC-200 transferFrom application call transaction
   */
  private static async buildArc200TransferFromCall(
    params: Arc200TransferFromParams,
    suggestedParams: algosdk.SuggestedParams,
    networkService: any
  ): Promise<{ transaction: algosdk.Transaction; simulated: boolean }> {
    try {
      // Create ABI method for proper encoding
      const method = new algosdk.ABIMethod(ARC200_TRANSFER_FROM_ABI);

      // Encode the method arguments properly
      const addressType = algosdk.ABIType.from('address');
      const uint256Type = algosdk.ABIType.from('uint256');

      // Build app args array with method selector and encoded arguments
      const appArgs = [
        method.getSelector(),
        addressType.encode(params.from), // owner
        addressType.encode(params.to), // recipient
        uint256Type.encode(params.amount),
      ];

      // Create suggested params without BigInt values for simulation
      const simulationParams = {
        ...suggestedParams,
        fee: Number(suggestedParams.fee),
        minFee: Number(suggestedParams.minFee),
      };

      // First, simulate the transaction to get the required box references
      const simulationTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: params.sender,
        appIndex: params.contractId,
        appArgs: appArgs,
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams: simulationParams,
      });

      // Simulate the transaction to get box references

      // Create a mock signed transaction with a 64-byte signature
      const mockSignedTxn = new algosdk.SignedTransaction({
        txn: simulationTxn,
        sig: new Uint8Array(64),
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
        fixSigners: true, // Automatically resolve signers for rekeyed accounts
      });

      let simulated = false;
      let boxes: { appIndex: number; name: Uint8Array }[] = [];

      try {
        const result = await this.simulateTransfer(
          simulateRequest,
          simulationTxn,
          simulationParams,
          params.contractId,
          networkService
        );
        const simulateResponse = result.response;
        simulated = result.simulated;

        // Extract box references from simulation
        const unnamedResources =
          simulateResponse.txnGroups?.[0]?.unnamedResourcesAccessed;
        const txnBoxes =
          simulateResponse.txnGroups?.[0]?.txnResults?.at(-1)
            ?.unnamedResourcesAccessed?.boxes;

        if (unnamedResources?.boxes || txnBoxes) {
          const allBoxes = [
            ...(unnamedResources?.boxes || []),
            ...(txnBoxes || []),
          ];

          // Convert simulation box references to transaction format
          boxes = allBoxes
            .filter((box) => Number(box.app) === params.contractId)
            .map((box) => ({
              appIndex: Number(box.app),
              name: new Uint8Array(box.name),
            }));
        }
      } catch (error) {
        console.error(
          'Failed to simulate ARC-200 transferFrom:',
          redactError(error)
        );
        throw error;
      }

      // Build the application call transaction with box references from simulation
      const appCallTxn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: params.sender,
        appIndex: params.contractId,
        appArgs: appArgs,
        boxes: boxes,
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams,
      });

      return { transaction: appCallTxn, simulated };
    } catch (error) {
      console.error(
        'Failed to build ARC-200 transferFrom call:',
        redactError(error)
      );
      throw new Error(
        `ARC-200 transferFrom call build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Build a batch claim transaction group for multiple tokens
   * Creates an atomic transaction group containing all claims
   */
  static async buildBatchClaimTransactionGroup(
    claims: Arc200ClaimParams[],
    networkId?: string,
    forceMbrPayment = false
  ): Promise<Arc200TransactionGroup> {
    if (claims.length === 0) {
      throw new Error('No claims provided');
    }

    // TASK-397: validate the whole batch before network access or construction.
    const claimsByContract = new Map<number, Set<string>>();
    const recipientsByContract = new Map<number, string>();
    for (const claim of claims) {
      const contractId = Number(claim.contractId);
      // The app call uses claim.sender directly, with no default fallback.
      const ownerAndSender = JSON.stringify([claim.from, claim.sender]);
      const seenClaims = claimsByContract.get(contractId) ?? new Set<string>();
      if (seenClaims.has(ownerAndSender)) {
        throw new Error(
          `Duplicate claim for token ${contractId} from ${claim.from} by ${claim.sender}`
        );
      }
      seenClaims.add(ownerAndSender);
      claimsByContract.set(contractId, seenClaims);

      if (
        recipientsByContract.has(contractId) &&
        recipientsByContract.get(contractId) !== claim.to
      ) {
        throw new Error(
          `All claims for token ${contractId} must go to the same recipient`
        );
      }
      recipientsByContract.set(contractId, claim.to);
    }

    const networkService = networkId
      ? NetworkService.getInstance(networkId as any)
      : defaultNetworkService;
    const suggestedParams = await networkService.getSuggestedParams();

    const allTransactions: algosdk.Transaction[] = [];
    let totalMbrNeeded = false;
    // GH #20: at most ONE MBR payment per contract. Every MBR payment for a
    // contract has the same sender, receiver, amount and note, so a second one
    // is a byte-identical transaction and the node rejects the whole group.
    // One payment covers the recipient's single balance box for that token
    // (the only caller, ClaimAllConfirmationScreen, sends every claim in a
    // batch to one recipient).
    const fundedContracts = new Set<number>();

    for (const claim of claims) {
      // Build transferFrom transaction for this claim
      const { transaction: transferFromTxn, simulated } =
        await this.buildArc200TransferFromCall(
          {
            contractId: claim.contractId,
            from: claim.from,
            to: claim.to,
            amount: claim.amount,
            sender: claim.sender,
            networkId,
          },
          suggestedParams,
          networkService
        );

      // Fund each recipient/contract at most once, before the claim needing it.
      // Check every sender so a later remote signer also gets the fail-safe.
      let needsMbrPayment = false;
      if (!fundedContracts.has(Number(claim.contractId))) {
        needsMbrPayment = await this.requiresMbr(
          claim.sender,
          simulated,
          forceMbrPayment,
          networkId
        );
      }

      if (needsMbrPayment) {
        fundedContracts.add(Number(claim.contractId));
        totalMbrNeeded = true;
        // Add MBR payment for this token
        const appEscrowAddress = algosdk.getApplicationAddress(
          claim.contractId
        );
        const mbrPaymentTxn =
          algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            sender: claim.sender,
            receiver: appEscrowAddress,
            amount: ARC200_MBR_AMOUNT,
            note: new Uint8Array(Buffer.from('MBR for ARC-200 claim')),
            suggestedParams,
          });
        allTransactions.push(mbrPaymentTxn);
      }

      allTransactions.push(transferFromTxn);
    }

    // Create atomic transaction group
    if (allTransactions.length > 1) {
      const groupId = algosdk.computeGroupID(allTransactions);
      allTransactions.forEach((txn) => (txn.group = groupId));
    }

    // Encode transactions
    const txnBytes = allTransactions.map((txn) =>
      algosdk.encodeUnsignedTransaction(txn)
    );

    return {
      transactions: allTransactions,
      txnBytes,
      needsMbrPayment: totalMbrNeeded,
    };
  }

  /**
   * Estimate the cost of claiming tokens
   * Returns fee per transaction and total estimated cost
   */
  static async estimateClaimCost(
    claimCount: Arc200ClaimParams[] | Arc200TransactionGroup,
    networkId?: string
  ): Promise<{
    feePerTxn: number;
    totalFees: number;
    totalMbr: number;
    total: number;
  }> {
    const group = Array.isArray(claimCount)
      ? await this.buildBatchClaimTransactionGroup(claimCount, networkId)
      : claimCount;
    const totalFees = group.transactions.reduce(
      (sum, txn) => sum + Number(txn.fee),
      0
    );
    const total = this.groupCost(group);
    return {
      feePerTxn: Number(group.transactions[0]?.fee || 0),
      totalFees,
      totalMbr: total - totalFees,
      total,
    };
  }
}

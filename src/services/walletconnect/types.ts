import {
  SessionTypes,
  SignClientTypes,
  ProposalTypes,
} from '@walletconnect/types';

export interface WalletConnectMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

export interface WalletConnectChainData {
  chainId: string;
  name: string;
  logo: string;
  rgb: string;
  rpc: string;
  namespace: string;
}

export interface WalletTransaction {
  txn: string;
  signers?: string[];
  authAddr?: string;
  msig?: {
    subsig: Array<{
      pk: string;
    }>;
    thr: number;
    v: number;
  };
  message?: string;
}

export interface AlgorandNamespace {
  chains: string[];
  methods: string[];
  events: string[];
  accounts: string[];
}

export interface WalletConnectRequestEvent {
  id: number;
  topic: string;
  params: {
    request: {
      method: string;
      params: any;
    };
    chainId: string;
  };
}

export interface WalletConnectSession {
  topic: string;
  peerMetadata: WalletConnectMetadata;
  namespaces: Record<
    string,
    {
      accounts: string[];
      methods: string[];
      events: string[];
      chains: string[];
    }
  >;
  expiry: number;
  acknowledged: boolean;
  controller: string;
  self: {
    publicKey: string;
    metadata: WalletConnectMetadata;
  };
  peer: {
    publicKey: string;
    metadata: WalletConnectMetadata;
  };
}

export interface SessionProposal {
  id: number;
  pairingTopic: string;
  proposer: {
    publicKey: string;
    metadata: WalletConnectMetadata;
  };
  requiredNamespaces: Record<string, ProposalTypes.RequiredNamespace>;
  optionalNamespaces?: Record<string, ProposalTypes.OptionalNamespace>;
  sessionProperties?: Record<string, string>;
  expiryTimestamp: number;
}

export type WalletConnectEventType =
  | 'session_proposal'
  | 'session_request'
  | 'session_delete'
  | 'session_expire'
  | 'session_update'
  | 'pairing_proposal'
  | 'pairing_delete';

export interface WalletConnectEventListener {
  type: WalletConnectEventType;
  handler: (event: any) => void;
}

export interface WalletConnectConfig {
  projectId: string;
  metadata: WalletConnectMetadata;
  chains: WalletConnectChainData[];
}

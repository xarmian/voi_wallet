import { WalletConnectService } from '@/services/walletconnect';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import type { CoordinatorTransport } from './requestCoordinator';

export function createCoordinatorTransport(): CoordinatorTransport {
  return {
    rejectRequestV2: (topic, id, error) =>
      WalletConnectService.getInstance().rejectRequest(topic, id as number, {
        code: error.code,
        message: error.message,
      }),
    rejectRequestV1: (id, message) =>
      WalletConnectV1Client.getInstance().rejectRequest(id as number, message),
    rejectProposalV2: (id, _pairingTopic, error) =>
      WalletConnectService.getInstance().rejectProposal(id as number, {
        code: error.code,
        message: error.message,
      }),
    rejectProposalV1: () => WalletConnectV1Client.getInstance().rejectSession(),
  };
}

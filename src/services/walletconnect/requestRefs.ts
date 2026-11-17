import type { RequestRef } from './requestCoordinator';

export const requestRefFor = (
  event: { id: number | string; topic: string },
  version: 1 | 2 = 2
): RequestRef => ({
  version,
  kind: 'request',
  topic: event.topic,
  id: event.id,
});

export const proposalRefFor = (proposal: {
  id: number | string;
  pairingTopic: string;
}): RequestRef => ({
  version: 2,
  kind: 'proposal',
  topic: proposal.pairingTopic,
  id: proposal.id,
});

export const v1ProposalRefFor = (sessionRequest: {
  id?: number | string;
}): RequestRef => ({
  version: 1,
  kind: 'proposal',
  topic: 'v1-proposal',
  id: sessionRequest?.id ?? 'v1',
});

export const requestExpiryOf = (event: {
  params?: { request?: { expiryTimestamp?: unknown } };
}): unknown => event?.params?.request?.expiryTimestamp;

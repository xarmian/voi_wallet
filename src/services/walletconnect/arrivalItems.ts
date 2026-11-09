import type { RequestRef } from './requestCoordinator';
import type { QueueDapp, QueueItem } from './requestQueue';

export type ArrivalItem = Omit<QueueItem, 'arrivalSeq' | 'kind'>;

interface PeerMetadataLike {
  name?: unknown;
  url?: unknown;
  icons?: unknown;
}

interface SessionLike {
  topic?: unknown;
  peerMetadata?: PeerMetadataLike;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * The dApp fields the lock-screen summary shows, from a peer's metadata. The
 * values are the dApp's own claims and are not trusted here; the summary
 * sanitises them when it draws.
 */
export function dappFromMetadata(meta: unknown): QueueDapp | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const { name, url, icons } = meta as PeerMetadataLike;
  const dapp: QueueDapp = {};
  const n = text(name);
  const u = text(url);
  const icon = Array.isArray(icons) ? text(icons[0]) : undefined;
  if (n) dapp.name = n;
  if (u) dapp.url = u;
  if (icon) dapp.icon = icon;
  return Object.keys(dapp).length > 0 ? dapp : undefined;
}

/** The chain a request targets, as the summary prints it. */
function networkOf(requestEvent: unknown): string | undefined {
  const chainId = (requestEvent as { params?: { chainId?: unknown } })?.params
    ?.chainId;
  if (typeof chainId === 'string' && chainId.length > 0) return chainId;
  if (typeof chainId === 'number') return String(chainId);
  return undefined;
}

/**
 * Queue metadata for an admitted signing request. The dApp comes from the
 * session the request arrived on; a lookup that finds nothing or throws leaves
 * the dApp out, because the summary has a fallback and the request must still
 * queue.
 */
export function requestArrival(args: {
  ref: RequestRef;
  requestEvent: unknown;
  firstSeenMs: number;
  sessions: () => readonly SessionLike[];
}): ArrivalItem {
  let dapp: QueueDapp | undefined;
  try {
    const session = args
      .sessions()
      .find((candidate) => candidate?.topic === args.ref.topic);
    dapp = dappFromMetadata(session?.peerMetadata);
  } catch {
    dapp = undefined;
  }
  return {
    ref: args.ref,
    payload: args.requestEvent,
    dapp,
    network: networkOf(args.requestEvent),
    firstSeenMs: args.firstSeenMs,
  };
}

/** Queue metadata for an admitted session proposal (v2 or v1). */
export function proposalArrival(args: {
  ref: RequestRef;
  payload: unknown;
  metadata: unknown;
  firstSeenMs: number;
}): ArrivalItem {
  return {
    ref: args.ref,
    payload: args.payload,
    dapp: dappFromMetadata(args.metadata),
    firstSeenMs: args.firstSeenMs,
  };
}

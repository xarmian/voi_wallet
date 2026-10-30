import { createStore } from 'zustand/vanilla';
import { NetworkService } from '@/services/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import { NetworkId } from '@/types/network';
import { subscribeRekeyInvalidation } from './rekeyStatusInvalidation';
import {
  classifyNetworkRekey,
  NetworkRekeyStatus,
  UNKNOWN,
} from './rekeyClassify';

export { classifyNetworkRekey };
export type { NetworkRekeyStatus };

// External rekeys (including dApp-submitted WalletConnect rekeys) rely on expiry.
// Refreshes bypass the network cache so the two TTLs cannot stack.
export const REKEY_STATUS_TTL = 10_000;
type Entry = { value: NetworkRekeyStatus; expires: number };
type Snapshot = { networks: NetworkId[]; entries: Record<string, Entry> };
const keyFor = (address: string, network: NetworkId) => `${address}:${network}`;

export function aggregateNetworkRekey(values: NetworkRekeyStatus[]): boolean {
  return (
    values.length > 0 && values.every((value) => value.status === 'delegated')
  );
}

export class NetworkRekeyStatusService {
  readonly store = createStore<Snapshot>(() => ({
    networks: Object.keys(NETWORK_CONFIGURATIONS) as NetworkId[],
    entries: {},
  }));
  private pending = new Map<string, Promise<void>>();
  private queue: (() => void)[] = [];
  private active = 0;
  private generation = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(
    private lookup = (address: string, network: NetworkId) =>
      NetworkService.getInstance(network).getAccountRekeyInfo(
        address,
        true,
        true
      )
  ) {}

  setNetworks(networks: NetworkId[]): void {
    const previous = this.store.getState().networks;
    if (
      networks.length === previous.length &&
      networks.every((n, i) => n === previous[i])
    )
      return;
    this.invalidate(networks);
  }
  invalidate(networks = this.store.getState().networks): void {
    this.generation++;
    this.pending.clear();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.store.setState({ networks: [...networks], entries: {} });
  }
  get(
    address: string,
    networks = this.store.getState().networks,
    entries = networks.map(
      (network) => this.store.getState().entries[keyFor(address, network)]
    )
  ) {
    const perNetwork = Object.fromEntries(
      networks.map((network, index) => {
        const entry = entries[index];
        return [
          network,
          entry && entry.expires > Date.now() ? entry.value : UNKNOWN,
        ];
      })
    ) as Record<NetworkId, NetworkRekeyStatus>;
    return {
      perNetwork,
      delegatedEverywhere: aggregateNetworkRekey(Object.values(perNetwork)),
    };
  }
  async ensure(address: string): Promise<void> {
    if (!address) return;
    await Promise.all(
      this.store
        .getState()
        .networks.map((network) => this.load(address, network))
    );
  }
  private load(address: string, network: NetworkId): Promise<void> {
    const key = keyFor(address, network);
    const entry = this.store.getState().entries[key];
    if (entry && entry.expires > Date.now()) return Promise.resolve();
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const promise = new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        void (async () => {
          try {
            if (generation !== this.generation) return;
            const expires = Date.now() + REKEY_STATUS_TTL;
            let value = UNKNOWN;
            try {
              value = classifyNetworkRekey(
                address,
                await this.lookup(address, network)
              );
            } catch {
              // Also yield for synchronous failures, before pending is registered.
              await Promise.resolve();
            }
            if (generation !== this.generation) return;
            const result = { value, expires };
            this.store.setState((state) => ({
              entries: { ...state.entries, [key]: result },
            }));
            const timer = setTimeout(
              () => {
                this.timers.delete(timer);
                if (this.store.getState().entries[key] !== result) return;
                this.store.setState((state) => {
                  const entries = { ...state.entries };
                  delete entries[key];
                  return { entries };
                });
              },
              Math.max(0, expires - Date.now())
            );
            this.timers.add(timer);
          } finally {
            if (generation === this.generation) this.pending.delete(key);
            this.active--;
            resolve();
            this.drain();
          }
        })();
      });
    });
    this.pending.set(key, promise);
    this.drain();
    return promise;
  }
  private drain(): void {
    while (this.active < 2 && this.queue.length) this.queue.shift()!();
  }
}
export const networkRekeyStatus = new NetworkRekeyStatusService();
subscribeRekeyInvalidation(() => networkRekeyStatus.invalidate());

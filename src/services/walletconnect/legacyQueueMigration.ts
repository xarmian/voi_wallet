import AsyncStorage from '@react-native-async-storage/async-storage';
import { redactError } from '@/utils/logRedaction';
import type { RequestCoordinator } from './requestCoordinator';
import { requestRefFor } from './requestRefs';

// Keys of the persisted signing queue that earlier builds wrote. Nothing writes
// them now; a build upgraded mid-session may still find them on first launch.
const LEGACY_QUEUE_KEY = '@walletconnect_transaction_queue';
const LEGACY_PROCESSING_KEY = '@walletconnect_queue_processing';

interface LegacyEntry {
  id: number | string;
  topic: string;
  version?: number;
}

const isLegacyEntry = (value: unknown): value is LegacyEntry => {
  if (!value || typeof value !== 'object') return false;
  const { id, topic } = value as Record<string, unknown>;
  return (
    typeof topic === 'string' &&
    (typeof id === 'string' || typeof id === 'number')
  );
};

const warn = (message: string, error: unknown): void => {
  console.warn(`[WalletConnect] ${message}:`, redactError(error));
};

/**
 * One-time migration of the persisted legacy signing queue. Every request it
 * finds is answered as expired and none is admitted, queued or shown: the
 * person never saw it in this build, and the dApp is owed an answer. Both
 * legacy keys are cleared whatever goes wrong, so the migration runs once.
 */
export async function settleLegacyQueue(
  coordinator: Pick<RequestCoordinator, 'settle'>
): Promise<void> {
  let entries: LegacyEntry[] = [];
  try {
    const raw = await AsyncStorage.getItem(LEGACY_QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) entries = parsed.filter(isLegacyEntry);
  } catch (error) {
    warn('Legacy request queue could not be read', error);
  }
  try {
    for (const entry of entries) {
      try {
        await coordinator.settle(
          requestRefFor(entry, entry.version === 1 ? 1 : 2),
          'expired'
        );
      } catch (error) {
        warn('Legacy request could not be answered', error);
      }
    }
  } finally {
    try {
      await AsyncStorage.multiRemove([LEGACY_QUEUE_KEY, LEGACY_PROCESSING_KEY]);
    } catch (error) {
      warn('Legacy request queue could not be cleared', error);
    }
  }
}

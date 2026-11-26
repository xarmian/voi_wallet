import { useSyncExternalStore } from 'react';
import { isCovered, subscribeCovered } from '@/utils/lockCover';

export function useCoverPaused(): boolean {
  return useSyncExternalStore(subscribeCovered, isCovered, isCovered);
}

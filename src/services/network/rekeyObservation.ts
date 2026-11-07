import { getRekeyStatusEpoch } from '@/services/wallet/rekeyStatusInvalidation';

/**
 * Provenance for an authority read (TASK-458, Codex pass C #3/#4): stamped
 * when the algod request is ISSUED, not when a caller records the result. A
 * cache hit returns the same object, so it keeps its original stamp and can
 * never pass for a newer observation.
 */
export type RekeyObservation = { epoch: number; seq: number };

const stamps = new WeakMap<object, RekeyObservation>();
let seq = 0;

export function issueRekeyObservation(): RekeyObservation {
  return { epoch: getRekeyStatusEpoch(), seq: ++seq };
}

export function stampRekeyInfo<T extends object>(
  info: T,
  observation: RekeyObservation
): T {
  stamps.set(info, observation);
  return info;
}

export function getRekeyObservation(
  info: object | null | undefined
): RekeyObservation | undefined {
  return info ? stamps.get(info) : undefined;
}

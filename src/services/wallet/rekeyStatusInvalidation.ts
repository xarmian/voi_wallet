// Shared by the network cache and aggregation cache, without store imports.
let epoch = 0;
const listeners = new Set<() => void>();
export const getRekeyStatusEpoch = () => epoch;
export function invalidateRekeyStatus(): void {
  epoch++;
  listeners.forEach((listener) => listener());
}
export function subscribeRekeyInvalidation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

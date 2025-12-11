/**
 * Callback Registry
 *
 * Stores callback functions that need to be passed between screens
 * without putting them in navigation params (which causes serialization warnings).
 *
 * Usage:
 * 1. Register callbacks before navigating:
 *    const callbackId = registerNavigationCallbacks({ onSuccess, onReject });
 *
 * 2. Pass only the callbackId in navigation params
 *
 * 3. In the target screen, retrieve and execute callbacks:
 *    const callbacks = getNavigationCallbacks(callbackId);
 *    callbacks?.onSuccess?.(result);
 *
 * 4. Clean up when done:
 *    clearNavigationCallbacks(callbackId);
 */

export interface NavigationCallbacks {
  onSuccess?: (result: any) => Promise<void>;
  onReject?: () => Promise<void>;
}

const callbackRegistry = new Map<string, NavigationCallbacks>();

/**
 * Generate a unique callback ID
 */
function generateCallbackId(): string {
  return `cb_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Register callbacks and return a unique ID to reference them
 */
export function registerNavigationCallbacks(
  callbacks: NavigationCallbacks
): string {
  const id = generateCallbackId();
  callbackRegistry.set(id, callbacks);
  return id;
}

/**
 * Retrieve callbacks by ID
 */
export function getNavigationCallbacks(
  id: string | undefined
): NavigationCallbacks | undefined {
  if (!id) return undefined;
  return callbackRegistry.get(id);
}

/**
 * Clear callbacks after use to prevent memory leaks
 */
export function clearNavigationCallbacks(id: string | undefined): void {
  if (id) {
    callbackRegistry.delete(id);
  }
}

/**
 * Clear all callbacks (useful for cleanup on app reset)
 */
export function clearAllNavigationCallbacks(): void {
  callbackRegistry.clear();
}

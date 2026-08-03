/**
 * Generation token for the deferred per-account notification subscribe pass
 * (TASK-192).
 *
 * `subscribeAllAccounts` is launched fire-and-forget from the service boot
 * (`navigation/serviceBootstrap.ts`) over a `wallet.accounts` snapshot captured
 * at launch. Nothing cancels that in-flight work: the mount effect's teardown
 * only removes listeners, and an account deleted mid-window is already gone
 * from storage by the time the pass writes. Batching the pass into a single
 * write makes that window materially larger — one delayed write instead of N
 * small independent ones — so the pass needs an abort token rather than luck.
 *
 * Contract: take a token at launch, re-check it immediately before the write,
 * and drop the write if it is stale. Both invalidation paths matter and they
 * are distinct:
 *   - teardown (unmount / disposal) — the session that launched the pass is
 *     gone;
 *   - account deletion — the session is alive and never unmounted, but the
 *     snapshot now names an account that no longer exists. Invalidated both in
 *     `walletStore.deleteAccount` (earliest point, before it even reads the
 *     account) and in `MultiAccountWalletService.deleteAccount` (the chokepoint
 *     every deletion funnels through, including callers that bypass the store —
 *     e.g. the watch→standard upgrade in AccountImportPreviewScreen).
 *
 * This lives in its own leaf module (no imports) so `walletStore` and
 * `serviceBootstrap` can invalidate without pulling in the notification
 * service's Expo/Supabase module graph, and without an import cycle.
 */

/**
 * Monotonic counter. A token is "current" only while it equals this value, so
 * any invalidation between take and check stales every token taken before it.
 */
let generation = 0;

/**
 * Take a token for a subscribe pass about to be launched. Call this
 * SYNCHRONOUSLY at launch — a token taken later would not cover the window it
 * is supposed to guard.
 */
export function takeAccountSubscribeToken(): number {
  return generation;
}

/**
 * Invalidate every in-flight subscribe pass. Called by the service-boot
 * teardown and by both deletion entry points. Cheap and idempotent-ish
 * (repeated calls simply advance the counter); it never blocks a future pass,
 * which takes a fresh token at its own launch.
 */
export function invalidateAccountSubscribePasses(): void {
  generation += 1;
}

/**
 * True if `token` still refers to the current generation, i.e. no teardown or
 * account deletion has happened since it was taken.
 */
export function isAccountSubscribeTokenCurrent(token: number): boolean {
  return token === generation;
}

import { isPinSetupPending } from '@/services/secure/pinSetupPending';
import type { EntryGuard } from './requestCoordinator';

// A read that never settles must not stall a dApp's request: past this bound the
// request is admitted, and the app stack still refuses to draw it.
const READ_BOUND_MS = 1500;

/**
 * Refuses a new request or proposal while PIN setup is unfinished (the durable
 * restore-before-PIN breadcrumb, the same marker AuthContext resumes setup
 * from). There is no PIN to unlock with and nothing to review it behind, so the
 * dApp is told now instead of waiting for a screen nobody can reach. Read on
 * every arrival, never cached, so it clears the moment setup completes.
 */
export const setupIncompleteGuard: EntryGuard = async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), READ_BOUND_MS);
  });
  try {
    const pending = await Promise.race([isPinSetupPending(), bound]);
    return pending ? 'setup-incomplete' : null;
  } finally {
    clearTimeout(timer);
  }
};

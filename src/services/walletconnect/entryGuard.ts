import {
  isPinSetupPending,
  isSetupResumeState,
} from '@/services/secure/pinSetupPending';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import type { EntryGuard } from './requestCoordinator';

// A read that never settles must not stall a dApp's request: past this bound
// the request is admitted.
const READ_BOUND_MS = 1500;

async function setupIsUnfinished(): Promise<boolean> {
  // The breadcrumb first: with none set, nothing else is read.
  if (!(await isPinSetupPending())) return false;
  const [hasKeyBearingAccount, hasPin] = await Promise.all([
    MultiAccountWalletService.hasKeyBearingAccountStrict(),
    AccountSecureStorage.hasPinStrict(),
  ]);
  return isSetupResumeState({ pending: true, hasKeyBearingAccount, hasPin });
}

/**
 * Refuses a new request or proposal while PIN setup is unfinished: the state
 * AuthContext resumes setup from (breadcrumb set, a key-bearing account, no
 * PIN), through the same predicate. Anything else admits, including a keyless
 * restored wallet that still carries the breadcrumb.
 *
 * Direction when a read errors or does not settle within the bound: admit. A
 * wrong refusal is durable and silent on a working wallet, while a wrong
 * admission needs an unreadable store during PIN setup, and software signing
 * still stops at the PIN requirement. Nothing else stands between an admitted
 * request and a drawn review in a running session, so this is a chosen
 * direction, not a safety net. Read on every arrival, never cached.
 */
export const setupIncompleteGuard: EntryGuard = async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), READ_BOUND_MS);
  });
  try {
    const unfinished = await Promise.race([setupIsUnfinished(), bound]);
    return unfinished ? 'setup-incomplete' : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

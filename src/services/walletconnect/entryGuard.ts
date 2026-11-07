import {
  isPinSetupPending,
  isSetupResumeState,
} from '@/services/secure/pinSetupPending';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { redactError } from '@/utils/logRedaction';
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

// Only fixed text is logged: an error from these reads can embed topics or ids
// the redactor cannot recognise.
const warn = (message: string): void => {
  console.warn('[EntryGuard]', redactError(new Error(message)));
};

/**
 * Refuses a new request or proposal while PIN setup is unfinished: the state
 * AuthContext resumes setup from (breadcrumb set, a key-bearing account, no
 * PIN), through the same predicate. Anything else admits, including a keyless
 * restored wallet that still carries the breadcrumb.
 *
 * Direction when a read errors or does not settle within the bound: admit, and
 * say so once in the log. A wrong refusal is durable and silent on a working
 * wallet. A wrong admission is possible even on a healthy store: during a
 * restore the breadcrumb is set before any key-bearing account exists, so an
 * arrival in that window is admitted. Nothing can sign there (software signing
 * stops at the PIN requirement), but nothing else stops a drawn review in a
 * running session, so this is a chosen direction, not a safety net. Read on
 * every arrival, never cached.
 */
export const setupIncompleteGuard: EntryGuard = async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => resolve('bound'), READ_BOUND_MS);
  });
  try {
    const unfinished = await Promise.race([setupIsUnfinished(), bound]);
    if (unfinished === 'bound') {
      warn('Entry guard read did not settle; admitting');
      return null;
    }
    return unfinished ? 'setup-incomplete' : null;
  } catch {
    warn('Entry guard could not be read; admitting');
    return null;
  } finally {
    clearTimeout(timer);
  }
};

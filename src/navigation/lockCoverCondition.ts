export interface CoverInput {
  authChecked: boolean;
  isLocked: boolean;
  isAuthenticated: boolean;
  hasPin: boolean;
  pinSetupResume: boolean;
  securityUnavailable: boolean;
}
export const SECURITY_SETUP_ROUTE = 'SecuritySetup';
// In S2 (PIN setup resumed, no PIN yet) a WalletConnect link can push one of
// these review routes. The lock screen would ask for a PIN that does not exist
// and hide the review's own gate, whose Reject is the person's way out. These
// routes show only that gate while locked (no request detail), so they are
// exempt in S2 exactly as SecuritySetup is, and nowhere else.
export const S2_REVIEW_ROUTES: readonly string[] = [
  'WalletConnectSessionProposal',
  'WalletConnectTransactionRequest',
  'WalletConnectError',
];
// WalletConnect-related root routes that are deliberately NOT exempt in S2, each
// with the reason. A new WalletConnect root route must be classified in one of
// these two lists; lockCoverCondition.test.ts fails otherwise.
export const S2_NOT_EXEMPT_ROUTES: Readonly<Record<string, string>> = {
  WalletConnectSessions: 'the session list, not a request review',
  WalletConnectPairing: 'pairing entry, not a request review',
  UniversalTransactionSigning:
    'shared with in-app signing, whose review is not gated while locked; a WalletConnect request can reach it in S2 until the entry-point guard refuses it earlier (U4 row)',
};
export function shouldCover(
  input: CoverInput,
  focusedRoute: string | null
): boolean {
  const resumingSetup =
    input.pinSetupResume &&
    !input.hasPin &&
    ((focusedRoute ?? SECURITY_SETUP_ROUTE) === SECURITY_SETUP_ROUTE ||
      S2_REVIEW_ROUTES.includes(focusedRoute ?? ''));
  return (
    input.authChecked &&
    !input.securityUnavailable &&
    (input.isLocked || !input.isAuthenticated) &&
    !resumingSetup
  );
}

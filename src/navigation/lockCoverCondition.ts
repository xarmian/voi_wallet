export interface CoverInput {
  authChecked: boolean;
  isLocked: boolean;
  isAuthenticated: boolean;
  hasPin: boolean;
  pinSetupResume: boolean;
  securityUnavailable: boolean;
}
// Only SecuritySetup is exempt in S2 (PIN setup resumed, no PIN yet). Any other
// route covers, but with no PIN there is nothing to unlock: RootLockBoundary
// never mounts a PIN pad in that case and sends the person back to
// SecuritySetup instead (see RootLockBoundary.tsx).
export const SECURITY_SETUP_ROUTE = 'SecuritySetup';
export function shouldCover(
  input: CoverInput,
  focusedRoute: string | null
): boolean {
  const resumingSetup =
    input.pinSetupResume &&
    !input.hasPin &&
    (focusedRoute ?? SECURITY_SETUP_ROUTE) === SECURITY_SETUP_ROUTE;
  return (
    input.authChecked &&
    !input.securityUnavailable &&
    (input.isLocked || !input.isAuthenticated) &&
    !resumingSetup
  );
}

export function hostMayDraw(input: {
  authChecked: boolean;
  securityUnavailable: boolean;
  hasPin: boolean;
  pinSetupResume: boolean;
}): boolean {
  return (
    input.authChecked &&
    !input.securityUnavailable &&
    !(input.pinSetupResume && !input.hasPin)
  );
}

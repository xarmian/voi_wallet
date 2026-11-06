export interface CoverInput {
  authChecked: boolean;
  isLocked: boolean;
  isAuthenticated: boolean;
  hasPin: boolean;
  pinSetupResume: boolean;
  securityUnavailable: boolean;
}
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

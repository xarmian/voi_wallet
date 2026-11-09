// What this census proves: every root <Stack.Screen> in AppNavigator has exactly
// one row here and no row is stale. rootRouteCoverage.test.ts compares route
// NAMES only.
// What it does not prove: that a route is hidden by the lock cover. The cover
// is a sibling View over the navigator, so it hides what the navigator draws
// inside the React Native root view. Routes with `presentation: 'modal'` are
// presented by the platform on iOS, possibly outside that view, and are not
// shown to be covered (TASK-540; a device check is pending).
// In S2 (PIN setup resumed, no PIN) only SecuritySetup is exempt. Every other
// route covers, but with no PIN the boundary never mounts a PIN pad and sends
// the person back to SecuritySetup (RootLockBoundary.tsx).
export const ROOT_ROUTE_COVERAGE: Record<
  string,
  { group: string; note?: string }
> = {
  Onboarding: { group: 'setup' },
  CreateWallet: { group: 'setup' },
  SecuritySetup: { group: 'security-setup', note: 'Exempt only in S2' },
  MnemonicImport: { group: 'import' },
  AddWatchAccount: { group: 'import' },
  QRAccountImport: { group: 'import' },
  AccountImportPreview: { group: 'import' },
  LedgerAccountImport: { group: 'import' },
  RestoreWallet: { group: 'import' },
  Main: { group: 'main' },
  UniversalTransactionSigning: { group: 'signing' },
  QRScanner: { group: 'signing' },
  WalletConnectSessions: { group: 'signing' },
  KeyregConfirm: { group: 'signing' },
  AppCallConfirm: { group: 'signing' },
  AppInfoModal: { group: 'signing' },
  SignRequestScanner: { group: 'signer-mode' },
  RemoteSignerTransactionReview: { group: 'signer-mode' },
  SignatureDisplay: { group: 'signer-mode' },
  WalletConnectPairing: {
    group: 'walletconnect-pending-deletion',
    note: 'Deleted in C2b U4; the host renders inside the cover',
  },
  WalletConnectError: {
    group: 'walletconnect-pending-deletion',
    note: 'Deleted in C2b U4; the host renders inside the cover',
  },
};

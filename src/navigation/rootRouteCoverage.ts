// Every root route is covered in S5. Only SecuritySetup is exempt in S2.
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
  WalletConnectSessionProposal: {
    group: 'walletconnect-pending-deletion',
    note: 'Deleted in C2b U4; the host renders inside the cover',
  },
  WalletConnectTransactionRequest: {
    group: 'walletconnect-pending-deletion',
    note: 'Deleted in C2b U4; the host renders inside the cover',
  },
  WalletConnectPairing: {
    group: 'walletconnect-pending-deletion',
    note: 'Deleted in C2b U4; the host renders inside the cover',
  },
  WalletConnectError: {
    group: 'walletconnect-pending-deletion',
    note: 'Deleted in C2b U4; the host renders inside the cover',
  },
};

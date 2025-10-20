let signingInProgress = false;

export const isLedgerSigningInProgress = (): boolean => signingInProgress;

export const setLedgerSigningInProgress = (value: boolean): void => {
  signingInProgress = value;
};

import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { getRekeyStateStrict, useAccounts } from '@/store/walletStore';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';

/** Messaging needs the source secret and a software transaction key on Voi. */
export function useMessagingSigner(
  account: AccountMetadata | null | undefined
) {
  const accounts = useAccounts();
  const signature = JSON.stringify(
    accounts.map(({ address, type, id }) => ({ address, type, id }))
  );
  const id = account?.id;
  const address = account?.address;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const identity = JSON.stringify([id, address, signature, attempt]);
  const [result, setResult] = useState<{
    identity: string;
    status: 'loaded' | 'error';
    isLedgerBacked: boolean;
    canUseMessaging: boolean;
  }>();
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setResult(undefined);
      if (id && address) {
        void (async () => {
          const wallet: Pick<AccountMetadata, 'address' | 'type' | 'id'>[] =
            JSON.parse(signature);
          const source = wallet.find((candidate) => candidate.id === id);
          const state = await getRekeyStateStrict(
            address,
            NetworkId.VOI_MAINNET
          );
          const signer = state.isRekeyed
            ? wallet.find(
                (candidate) => candidate.address === state.authAddress
              )
            : source;
          const isLedgerBacked =
            source?.type === AccountType.LEDGER ||
            signer?.type === AccountType.LEDGER;
          const hasSourceSecret =
            (source?.type === AccountType.STANDARD ||
              source?.type === AccountType.REKEYED) &&
            (await AccountSecureStorage.probeSecretPresenceStrict(id));
          const hasTransactionKey =
            !state.isRekeyed ||
            (signer?.type === AccountType.STANDARD &&
              (await AccountSecureStorage.probeSecretPresenceStrict(
                signer.id
              )));
          if (!cancelled)
            setResult({
              identity,
              status: 'loaded',
              isLedgerBacked,
              canUseMessaging:
                !!hasSourceSecret && hasTransactionKey && !isLedgerBacked,
            });
        })().catch(() => {
          if (!cancelled)
            setResult({
              identity,
              status: 'error',
              isLedgerBacked: false,
              canUseMessaging: false,
            });
        });
      }
      return () => {
        cancelled = true;
      };
    }, [id, address, signature, identity])
  );
  const status = result?.identity === identity ? result.status : 'loading';
  const ready = status === 'loaded';
  return {
    status,
    ready,
    retry,
    isLedgerBacked: ready && !!result?.isLedgerBacked,
    canUseMessaging: ready && !!result?.canUseMessaging,
  };
}

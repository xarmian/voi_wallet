import React, { useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import UnifiedAuthModal from './UnifiedAuthModal';
import {
  FreshAuthPrompter,
  FreshAuthReason,
  registerFreshAuthPrompter,
} from '@/services/secure/freshAuth';

const copy: Record<FreshAuthReason, { title: string; message: string }> = {
  reveal_recovery_phrase: {
    title: 'Show Recovery Phrase',
    message: 'Authenticate to view your recovery phrase.',
  },
  verify_backup: {
    title: 'Verify Backup',
    message: 'Authenticate to verify your recovery phrase.',
  },
  export_backup: {
    title: 'Create Backup',
    message: 'Authenticate to create an encrypted wallet backup.',
  },
  export_private_key: {
    title: 'Export Private Key',
    message: 'Authenticate to export this private key.',
  },
};

export default function FreshAuthHost() {
  const [active, setActive] = useState<{
    reason: FreshAuthReason;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const pendingResolveRef = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    let mounted = true;
    const prompter: FreshAuthPrompter = (reason, signal) =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          appStateSubscription?.remove?.();
          resolve(ok);
          pendingResolveRef.current = null;
          if (mounted) setActive(null);
        };
        const onAbort = () => finish(false);
        const appStateSubscription = AppState.addEventListener(
          'change',
          (state: AppStateStatus) => {
            // 'background' only: on iOS the Face ID system sheet itself moves
            // the app to 'inactive', so cancelling on 'inactive' would kill the
            // biometric prompt this modal opens.
            if (state === 'background') finish(false);
          }
        );
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) finish(false);
        else {
          pendingResolveRef.current = finish;
          setActive({ reason, resolve: finish });
        }
      });
    const unregister = registerFreshAuthPrompter(prompter);
    return () => {
      mounted = false;
      pendingResolveRef.current?.(false);
      unregister();
    };
  }, []);

  const promptCopy = active ? copy[active.reason] : undefined;
  return (
    <UnifiedAuthModal
      visible={!!active}
      purpose="export_keys"
      title={promptCopy?.title}
      message={promptCopy?.message}
      onSuccess={() => active?.resolve(true)}
      onCancel={() => active?.resolve(false)}
    />
  );
}

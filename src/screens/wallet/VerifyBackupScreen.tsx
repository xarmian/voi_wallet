/**
 * VerifyBackupScreen — lets a user confirm an existing account's recovery
 * phrase after the fact, clearing the Home un-backed-up warning (TASK-45).
 *
 * Without this the banner would be a dead-end nag: skipping the quiz during
 * onboarding, or restoring from a backup (where `backupVerified` deliberately
 * resets to false, DR-11), would leave a permanent warning with no way to
 * resolve it.
 *
 * ## Key handling (DR-9)
 *
 * The phrase is NOT passed in — the route carries only the account ADDRESS, and
 * the screen loads the phrase itself through a fresh-auth gated service, the
 * same PIN/biometric-gated path `ShowRecoveryPhraseScreen` already uses. So no
 * new mnemonic reaches navigation state, storage, or logs. The phrase lives in
 * component state for the duration of the quiz and is cleared on unmount.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Alert,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { withFreshAuth } from '@/services/secure/freshAuth';
import { useActiveAccount, useWalletStore } from '@/store/walletStore';
import { AccountType } from '@/types/wallet';
import MnemonicVerification from '@/components/wallet/MnemonicVerification';
import UniversalHeader from '@/components/common/UniversalHeader';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { NFTBackground } from '@/components/common/NFTBackground';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useSecureScreen } from '@/hooks/useSecureScreen';
import { Theme } from '@/constants/themes';

interface RouteParams {
  /** Address of the account to verify. NEVER a phrase or key. */
  accountAddress?: string;
}

export default function VerifyBackupScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { accountAddress } = (route.params as RouteParams) ?? {};
  const styles = useThemedStyles(createStyles);

  // The phrase is rendered on this screen, so block screenshots/recordings.
  useSecureScreen();

  const activeAccount = useActiveAccount();
  const markBackupVerified = useWalletStore(
    (state) => state.markBackupVerified
  );

  const accounts = useWalletStore((state) => state.wallet?.accounts);
  // `undefined` means the wallet has not been loaded into the store yet — not
  // "no such account". Distinguishing them keeps a cold-boot mount in the
  // loading state instead of flashing "nothing to verify" and pinning nothing.
  const walletLoaded = accounts !== undefined;

  // Resolve the target on the FIRST render where it can be resolved, then pin it
  // for the lifetime of the screen. The store is live: if the active account
  // changed (or the account list was re-ordered) while the quiz was open, a
  // dynamically-resolved target would let us mark account B as verified using
  // account A's phrase. The address param is preferred; the active account is
  // only the entry default.
  const targetRef = useRef<{ id: string; address: string } | null>(null);
  if (targetRef.current === null) {
    const resolved = accountAddress
      ? accounts?.find(
          (account) =>
            account.address === accountAddress &&
            (account.type === AccountType.STANDARD ||
              account.type === AccountType.REKEYED)
        )
      : activeAccount?.type === AccountType.STANDARD ||
          activeAccount?.type === AccountType.REKEYED
        ? activeAccount
        : undefined;
    if (resolved) {
      targetRef.current = { id: resolved.id, address: resolved.address };
    }
  }
  // eslint-disable-next-line react-hooks/refs -- Deliberate write-then-read latch (see :59-64). The target is resolved on the FIRST render where resolution is possible and then PINNED for the screen's lifetime. The store is live: a dynamically-resolved target would let a mid-quiz active-account change mark account B as verified using account A's displayed phrase. Reading targetRef.current here is the pin. The naive "correct" refactor is actively dangerous and is guarded by a real test (VerifyBackupScreen.test.tsx). Carve-out per TASK-242; NOT to be rewritten.
  const target = targetRef.current;

  const [mnemonic, setMnemonic] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The load starts ONCE per mount. A second start while the first prompt is
  // still open would be refused as busy and discard the user's authentication
  // (the wallet-hydration flip below re-runs this effect), so a ref guards it.
  const loadStartedRef = useRef(false);
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Still hydrating and nothing pinned yet — stay in the loading state and
    // wait for the next render rather than declaring the account unverifiable.
    if (!walletLoaded && !target) return;
    if (loadStartedRef.current) return;
    loadStartedRef.current = true;

    const abort = new AbortController();
    loadAbortRef.current = abort;

    const load = async () => {
      if (!target) {
        setIsLoading(false);
        setLoadError('This account has no recovery phrase to verify.');
        return;
      }
      try {
        const phrase = await withFreshAuth(
          'verify_backup',
          (cap) =>
            SecureKeyManager.revealMnemonic(
              target.address,
              cap,
              'verify_backup'
            ),
          { signal: abort.signal }
        );
        if (abort.signal.aborted) return;
        setMnemonic(phrase);
        setLoadError(null);
      } catch (error) {
        // Never surface the underlying error text — it can echo key-store
        // internals. The user just needs to know it failed.
        if (abort.signal.aborted) return;
        // A cancelled prompt shows nothing and leaves; any other failure keeps
        // the screen with the message, as before the gate.
        if ((error as { code?: string } | null)?.code === 'cancelled') {
          navigation.goBack();
          return;
        }
        setLoadError(
          'Could not load your recovery phrase. Please try again from Settings.'
        );
      } finally {
        if (!abort.signal.aborted) setIsLoading(false);
      }
    };

    void load();
    // `target` is pinned once resolved, so the load runs exactly once.
  }, [target, walletLoaded, navigation]);

  // The app going to the background cancels a pending prompt and drops the
  // phrase from component state.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        loadAbortRef.current?.abort();
        setMnemonic('');
        navigation.goBack();
      }
    });
    return () => subscription?.remove?.();
  }, [navigation]);

  // Leaving the screen cancels a pending prompt and drops the phrase. Its own
  // effect with no dependencies, so a changed `navigation` never aborts a load.
  useEffect(
    () => () => {
      loadAbortRef.current?.abort();
      setMnemonic('');
    },
    []
  );

  const handleVerified = useCallback(async () => {
    if (!target) return;
    // The service re-checks, inside its serialized write, that this exact
    // account still exists at the same address and holds its own key. A deleted
    // account or a wallet reset fails closed instead of marking something else.
    try {
      await markBackupVerified(target.id, target.address);
      setMnemonic('');
      Alert.alert(
        'Backup confirmed',
        'Your recovery phrase is confirmed for this account.',
        [{ text: 'Done', onPress: () => navigation.goBack() }]
      );
    } catch {
      Alert.alert(
        'Could not save',
        'We could not record the confirmation. Please try again.'
      );
    }
  }, [markBackupVerified, navigation, target]);

  // TASK-226: the challenge restarts itself after too many wrong answers. The
  // onboarding hosts send the user back to the phrase at that point; this screen
  // has no phrase step to return to, so it leaves instead. That is friction, not
  // a lockout — the entry point is still there, and re-entering re-reads the
  // phrase from the gated key store.
  const handleFailed = useCallback(() => {
    setMnemonic('');
    Alert.alert(
      'Too many incorrect answers',
      'Check your written recovery phrase and try again from Settings.',
      [{ text: 'OK', onPress: () => navigation.goBack() }]
    );
  }, [navigation]);

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <UniversalHeader
          title="Confirm Recovery Phrase"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />
        <KeyboardAwareScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {isLoading ? (
            <View style={styles.centered} testID="verify-backup-loading">
              <ActivityIndicator size="large" />
              <Text style={styles.message}>Loading your recovery phrase…</Text>
            </View>
          ) : loadError !== null ? (
            <View style={styles.centered}>
              <Text
                style={styles.message}
                accessibilityRole="alert"
                testID="verify-backup-error"
              >
                {loadError}
              </Text>
            </View>
          ) : (
            <MnemonicVerification
              mnemonic={mnemonic}
              onVerified={handleVerified}
              onFailed={handleFailed}
              testIDPrefix="verify-backup"
            />
          )}
        </KeyboardAwareScrollView>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.lg,
      paddingBottom: 100,
    },
    centered: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xxl,
      gap: theme.spacing.md,
    },
    message: {
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
    },
  });

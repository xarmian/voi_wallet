import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useCoverPaused } from '@/hooks/useCoverPaused';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useWalletStore } from '@/store/walletStore';
import { FreshAuthError, withFreshAuth } from '@/services/secure/freshAuth';
import {
  FoundAccountMismatchError,
  FoundAccountOnlyCopyError,
  FoundAccountWalletKeyUncheckedError,
} from '@/services/secure/AccountSecureStorage';
import {
  actionableCount,
  idsNeedingScan,
  inWalletNeedsVerdict,
  walletHoldsOwnKey,
} from '@/services/secure/foundAccountsCount';
import {
  readFoundAccountsSummary,
  removeFoundAccount,
  restoreFoundAccount,
  scanFoundAccounts,
  type FoundRow,
  type FoundSummary,
} from '@/services/secure/foundAccounts';
import { formatAddress } from '@/utils/address';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'no-pin'; count: number }
  | { kind: 'needs-auth'; summary: FoundSummary }
  | { kind: 'scanning' }
  | { kind: 'list'; summary: FoundSummary }
  | { kind: 'empty' }
  | { kind: 'error' };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const onlyCopyText = (address: string) =>
  `This key is the only usable copy for ${formatAddress(address)} on this device. It's kept here.`;

/** The wallet account's name, or its short address when it has no label. */
const walletName = (row: Extract<FoundRow, { kind: 'in-wallet' }>) =>
  row.walletLabel || formatAddress(row.address);

/** An in-wallet row whose wallet account can't use the key: how to recover. */
const onlyCopyRowText = (row: Extract<FoundRow, { kind: 'in-wallet' }>) =>
  `${onlyCopyText(row.address)} To use it, remove the account "${walletName(row)}" from your wallet, then restore it here.`;

/** An in-wallet row the auth-gated scan has not checked yet. */
const notCheckedRowText = (row: Extract<FoundRow, { kind: 'in-wallet' }>) =>
  `It hasn't been checked yet whether ${walletName(row)} still holds its key.`;

/** A row the needs-auth state lists: what the next scan will check. */
const needsScan = (row: FoundRow) =>
  row.kind === 'unscanned' || inWalletNeedsVerdict(row);

function authAlert(error: FreshAuthError, what: string) {
  // A cancel shows nothing; other auth failures say so without detail.
  if (error.code !== 'cancelled')
    Alert.alert('Authentication Error', `Could not authenticate to ${what}.`);
}

/**
 * TASK-478: accounts whose keys were found on this device. The list is built
 * from ids, addresses and labels only; reading a key (the scan, a restore, a
 * remove) happens only inside a fresh authentication.
 */
export default function FoundAccountsScreen() {
  const navigation = useNavigation();
  const covered = useCoverPaused();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const refreshWallet = useWalletStore((state) => state.refresh);
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // The automatic scan runs on the first load after mount only, never from a
  // reload after a restore, remove or rescan.
  const autoScannedRef = useRef(false);
  const mountedRef = useRef(false);

  const nextSignal = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // A confirmation answered after the screen went away must not open an
    // authentication prompt over whatever is showing now.
    if (!mountedRef.current) controller.abort();
    return controller.signal;
  };

  /** 'ok' also covers a scan that stopped part way: what it read is kept. */
  const runScan = useCallback(
    async (ids: string[]): Promise<'ok' | 'auth-failed'> => {
      // Never open a prompt for a screen that has gone.
      if (!mountedRef.current) return 'auth-failed';
      try {
        await withFreshAuth(
          'scan_found_accounts',
          (cap) => scanFoundAccounts(ids, cap),
          { signal: nextSignal() }
        );
      } catch (error) {
        if (error instanceof FreshAuthError) {
          authAlert(error, 'check the accounts found on this device');
          return 'auth-failed';
        }
        console.warn('Found-accounts scan stopped');
      }
      return 'ok';
    },
    []
  );

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    const generation = ++generationRef.current;
    const current = () => generation === generationRef.current;
    // At most two passes: a scan on the first visit, then the list it left.
    for (;;) {
      let summary: FoundSummary;
      try {
        summary = await readFoundAccountsSummary();
      } catch {
        if (current()) setState({ kind: 'error' });
        return;
      }
      if (!current()) return;
      if (!summary.hasPin) {
        const count = actionableCount(summary);
        // Nothing to act on: the empty state, never "0 accounts found".
        setState(count > 0 ? { kind: 'no-pin', count } : { kind: 'empty' });
        return;
      }
      // Unscanned keys, and in-wallet copies with no verdict on whether their
      // wallet account still holds its key.
      const pending = idsNeedingScan(summary);
      if (pending.length > 0) {
        if (autoScannedRef.current) {
          setState({ kind: 'needs-auth', summary });
          return;
        }
        autoScannedRef.current = true;
        setState({ kind: 'scanning' });
        const scanned = await runScan(pending);
        if (!current()) return;
        if (scanned === 'auth-failed') {
          setState({ kind: 'needs-auth', summary });
          return;
        }
        continue;
      }
      setState(
        summary.presentCount === 0
          ? { kind: 'empty' }
          : { kind: 'list', summary }
      );
      return;
    }
  }, [runScan]);

  useEffect(() => {
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after awaiting the storage read.
    void load();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (covered) abortRef.current?.abort();
  }, [covered]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      // Face ID can make iOS inactive; only background aborts its own prompt.
      if (next === 'background') abortRef.current?.abort();
    });
    return () => subscription?.remove?.();
  }, []);

  const rescan = async (ids: string[]) => {
    if (busyId) return;
    autoScannedRef.current = true;
    setBusyId('scan');
    setState({ kind: 'scanning' });
    try {
      await runScan(ids);
    } finally {
      setBusyId(null);
      void load();
    }
  };

  const restore = async (row: Extract<FoundRow, { kind: 'ready' }>) => {
    if (busyId) return;
    autoScannedRef.current = true;
    setBusyId(row.id);
    // Set only when the prompt failed, so nothing was read or written.
    let authFailed = false;
    try {
      const result = await withFreshAuth(
        'restore_found_account',
        (cap) => restoreFoundAccount(row.id, row.address, cap),
        { signal: nextSignal() }
      );
      if (result.kind === 'restored-unconfirmed')
        Alert.alert(
          'Restore Account',
          "The account was added to your wallet, but this step didn't finish. The found key may still be on this device; check this screen again after restarting the app."
        );
      else
        Alert.alert(
          'Account restored',
          result.kind === 'restored'
            ? undefined
            : 'The found copy is still on this device; you can remove it here.'
        );
    } catch (error) {
      if (error instanceof FreshAuthError) {
        authFailed = true;
        authAlert(error, 'restore this account');
      } else if (error instanceof FoundAccountMismatchError)
        Alert.alert(
          'Restore Account',
          'This key no longer matches the listed address. Nothing was changed.'
        );
      else
        Alert.alert(
          'Restore Account',
          "Couldn't restore this account. Nothing was removed."
        );
    } finally {
      if (!authFailed) await refreshWallet().catch(() => undefined);
      setBusyId(null);
      void load();
    }
  };

  const confirmRestore = (row: Extract<FoundRow, { kind: 'ready' }>) => {
    Alert.alert(
      'Restore Account',
      `Add ${formatAddress(row.address)} to your accounts using the key found on this device?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore', onPress: () => void restore(row) },
      ]
    );
  };

  /** `onlyCopy`: what a FoundAccountOnlyCopyError says for this row. */
  const remove = async (ids: string[], onlyCopy: string) => {
    if (busyId) return;
    autoScannedRef.current = true;
    setBusyId(ids[0]);
    try {
      await withFreshAuth(
        'remove_found_account',
        (cap) => removeFoundAccount(ids, cap),
        { signal: nextSignal() }
      );
    } catch (error) {
      if (error instanceof FreshAuthError) authAlert(error, 'remove this key');
      else if (error instanceof FoundAccountWalletKeyUncheckedError)
        Alert.alert(
          'Remove Key',
          "Couldn't check this account's own key right now. Nothing was removed. Unlock the wallet and try again."
        );
      else if (error instanceof FoundAccountOnlyCopyError)
        Alert.alert('Remove Key', onlyCopy);
      else Alert.alert('Remove Key', "Couldn't remove this key.");
    } finally {
      setBusyId(null);
      void load();
    }
  };

  const confirmRemove = (ids: string[], address: string, onlyCopy: string) => {
    Alert.alert(
      'Remove this key?',
      `This deletes this key from this device. If you don't have this account's recovery phrase, restore it first and back the phrase up. Without it, funds at ${formatAddress(address)} may not be reachable from this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void remove(ids, onlyCopy),
        },
      ]
    );
  };

  const button = (
    label: string,
    onPress: () => void,
    variant: 'primary' | 'secondary' | 'danger' = 'primary'
  ) => (
    <ActionButton
      key={label}
      label={label}
      onPress={onPress}
      variant={variant}
      disabled={busyId !== null}
      styles={styles}
    />
  );

  const renderRow = (row: FoundRow) => {
    if (row.kind === 'unscanned')
      return (
        <View key={row.id} style={styles.card}>
          <Text style={styles.address}>
            {row.hintAddress ? formatAddress(row.hintAddress) : 'Account'}
          </Text>
          {row.hintLabel ? (
            <Text style={styles.label}>{row.hintLabel}</Text>
          ) : null}
        </View>
      );
    if (row.kind === 'ready')
      return (
        <View key={row.id} style={styles.card}>
          <Text style={styles.address}>{formatAddress(row.address)}</Text>
          {row.label ? <Text style={styles.label}>{row.label}</Text> : null}
          <View style={styles.actions}>
            {button('Restore', () => confirmRestore(row))}
            {button(
              'Remove',
              () =>
                confirmRemove(row.ids, row.address, onlyCopyText(row.address)),
              'danger'
            )}
          </View>
          {busyId === row.id ? (
            <ActivityIndicator color={theme.colors.primary} />
          ) : null}
        </View>
      );
    return (
      <View key={row.id} style={styles.card}>
        <Text style={styles.address}>{formatAddress(row.address)}</Text>
        {walletHoldsOwnKey(row) ? (
          <>
            <Text style={styles.label}>
              {`Already in your wallet as ${walletName(row)}`}
            </Text>
            <View style={styles.actions}>
              {button(
                'Remove',
                () =>
                  confirmRemove([row.id], row.address, onlyCopyRowText(row)),
                'danger'
              )}
            </View>
          </>
        ) : (
          <Text style={styles.label}>
            {/* A keyless type is the only copy whatever the verdict says. */}
            {inWalletNeedsVerdict(row)
              ? notCheckedRowText(row)
              : onlyCopyRowText(row)}
          </Text>
        )}
      </View>
    );
  };

  const renderBody = () => {
    switch (state.kind) {
      case 'loading':
      case 'scanning':
        return (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        );
      case 'no-pin':
        return (
          <View style={styles.card}>
            <Text style={styles.title}>
              {`${plural(state.count, 'account')} found on this device`}
            </Text>
            <Text style={styles.body}>
              To recover these, this wallet needs a PIN. Create or import an
              account to set one, then come back here.
            </Text>
          </View>
        );
      case 'needs-auth': {
        const pending = idsNeedingScan(state.summary);
        return (
          <>
            <Text style={styles.body}>
              Authenticate to check the keys found on this device, and whether
              the wallet accounts they belong to still hold their own keys.
            </Text>
            {state.summary.rows.filter(needsScan).map(renderRow)}
            {button(
              `Check ${plural(pending.length, 'account')}`,
              () => void rescan(pending)
            )}
          </>
        );
      }
      case 'list': {
        const m = state.summary.unreadableIds.length;
        return (
          <>
            {state.summary.rows.map(renderRow)}
            {m > 0 ? (
              <View style={styles.card}>
                <Text style={styles.body}>
                  {`${plural(m, 'account')} couldn't be read. Their keys stay on this device; Delete Everything removes them.`}
                </Text>
                <View style={styles.actions}>
                  {button(
                    'Try again',
                    () => void rescan(state.summary.unreadableIds),
                    'secondary'
                  )}
                </View>
              </View>
            ) : null}
          </>
        );
      }
      case 'empty':
        return (
          <Text style={styles.body}>No accounts found on this device.</Text>
        );
      case 'error':
        return (
          <View style={styles.card}>
            <Text style={styles.body}>
              {"Couldn't check the accounts on this device."}
            </Text>
            <View style={styles.actions}>
              {button('Retry', () => void load(), 'secondary')}
            </View>
          </View>
        );
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={24} color={theme.colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Found on This Device</Text>
        <View style={styles.placeholder} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {renderBody()}
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionButton({
  label,
  onPress,
  variant,
  disabled,
  styles,
}: {
  label: string;
  onPress: () => void;
  variant: 'primary' | 'secondary' | 'danger';
  disabled: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.button,
        variant === 'secondary' && styles.secondaryButton,
        variant === 'danger' && styles.dangerButton,
        disabled && styles.disabled,
      ]}
      accessibilityRole="button"
    >
      <Text
        style={[
          styles.buttonText,
          variant !== 'primary' && styles.secondaryButtonText,
          variant === 'danger' && styles.dangerButtonText,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    backButton: { padding: theme.spacing.sm },
    headerTitle: { fontSize: 18, fontWeight: '600', color: theme.colors.text },
    placeholder: { width: 40 },
    content: { padding: theme.spacing.lg, gap: theme.spacing.md },
    center: { alignItems: 'center', paddingVertical: theme.spacing.xxl },
    card: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    title: { fontSize: 16, fontWeight: '600', color: theme.colors.text },
    body: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
    address: { fontSize: 16, fontWeight: '600', color: theme.colors.text },
    label: { fontSize: 14, color: theme.colors.textSecondary },
    actions: { flexDirection: 'row', gap: theme.spacing.sm },
    button: {
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.primary,
      alignSelf: 'flex-start',
    },
    secondaryButton: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    dangerButton: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: theme.colors.error,
    },
    disabled: { opacity: 0.5 },
    buttonText: { color: theme.colors.buttonText, fontWeight: '600' },
    secondaryButtonText: { color: theme.colors.primary },
    dangerButtonText: { color: theme.colors.error },
  });

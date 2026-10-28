import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure';
import {
  AccountType,
  ImportAccountRequest,
  AddWatchAccountRequest,
} from '@/types/wallet';
import {
  getAccountSecret,
  clearAccountSecret,
  clearAccountSecrets,
} from '@/utils/accountQRParser';
import { useTheme } from '@/contexts/ThemeContext';
import { useAuth } from '@/contexts/AuthContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import UniversalHeader from '@/components/common/UniversalHeader';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';
import { GlassInput } from '@/components/common/GlassInput';
import { PassphraseStrengthMeter } from '@/components/common/PassphraseStrengthMeter';
import type { SecretSource } from '@/services/secure/SessionKeyVault';
import { redactAddress, redactError } from '@/utils/logRedaction';

const PASSPHRASE_MIN = AccountSecureStorage.PASSPHRASE_MIN_LENGTH;

type SecuritySetupScreenNavigationProp = NativeStackNavigationProp<
  RootStackParamList,
  'SecuritySetup'
>;

const MNEMONIC_UNAVAILABLE_MESSAGE =
  'Your recovery phrase is no longer available. Please go back and try again.';

type SecuritySetupScreenRouteProp = RouteProp<
  RootStackParamList,
  'SecuritySetup'
>;

interface Props {
  navigation: SecuritySetupScreenNavigationProp;
  route: SecuritySetupScreenRouteProp;
}

export default function SecuritySetupScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  // TASK-213: set the PIN through AuthContext (not AccountSecureStorage directly)
  // so authState.hasPin flips to true on success. Otherwise a wallet set up in this
  // session — including the cold-restore RESUME path (pinSetupResume) — would keep
  // hasPin=false in context, and lock()/inactivity/background auto-lock would no-op
  // until the NEXT launch. AuthContext.setupPin delegates to the same atomic
  // AccountSecureStorage.setupPin and then updates hasPin.
  const { setupPin: authSetupPin } = useAuth();
  const styles = useThemedStyles(createStyles);
  const [mode, setMode] = useState<SecretSource>('pin');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [setupStep, setSetupStep] = useState('');
  const {
    // TASK-224: opaque id into the in-memory secret store — never the phrase.
    mnemonicSecretId,
    accounts,
    source = 'create',
    accountLabel: initialAccountLabel,
    // TASK-45 / DR-11 carrier #1. Only an explicit `true` counts; any other
    // value (absent, undefined, or a stale/rehydrated param) persists the
    // account as un-backed-up.
    backupVerified: backupVerifiedParam,
  } = route.params;
  const [accountLabel, setAccountLabel] = useState(initialAccountLabel ?? '');
  // Synchronous in-flight guard. `submitting` is state, so a second tap can land
  // before the re-render; this ref is checked and set in the same tick.
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  // Set once authSetupPin has committed in THIS screen session, so a retry after
  // an import failure does not run first-secret setup a second time over the
  // credential it just created (see handleComplete). Holds the same PIN the
  // `pin` state already holds; dropped on success and on unmount.
  const committedSecretRef = useRef<{
    secret: string;
    mode: SecretSource;
  } | null>(null);

  React.useEffect(() => {
    checkBiometricAvailability();
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      committedSecretRef.current = null;
    };
  }, []);

  // While a submit is in flight, leaving would strand a half-done setup (e.g. a
  // PIN committed with no account). Block every pop path: header back is hidden,
  // the iOS swipe gesture is disabled, and beforeRemove (hardware back, any
  // programmatic pop) is prevented.
  React.useEffect(() => {
    navigation.setOptions({ gestureEnabled: !submitting });
  }, [navigation, submitting]);

  React.useEffect(() => {
    return navigation.addListener('beforeRemove', (e) => {
      if (submittingRef.current) {
        e.preventDefault();
      }
    });
  }, [navigation]);

  React.useEffect(() => {
    return () => {
      if (accounts) {
        clearAccountSecrets(accounts.map((acc) => acc.secretId));
      }
      // TASK-224: unmount (back, swipe-dismiss, hardware back, completion)
      // releases the recovery phrase too. The source screen stores a fresh id
      // on every navigate, so returning and continuing again still works.
      // Skipped while a submit is in flight: that submit's own finally releases
      // it once the import has run (it checks mountedRef).
      if (!submittingRef.current) {
        clearAccountSecret(mnemonicSecretId);
      }
    };
  }, [accounts, mnemonicSecretId]);

  const isPhraseSource = source === 'create' || source === 'mnemonic';
  // Presence check only — the copy returned by getAccountSecret is dropped
  // immediately. Used to fail BEFORE any PIN is set when the phrase is gone
  // (e.g. TASK-213 cold-boot: params rehydrate, the in-memory store does not).
  const hasStoredMnemonic = (): boolean =>
    !!mnemonicSecretId && !!getAccountSecret(mnemonicSecretId)?.mnemonic;

  const checkBiometricAvailability = async () => {
    const available = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    setBiometricAvailable(available && enrolled);
  };

  const isPassphrase = mode === 'passphrase';
  const secretLabel = isPassphrase ? 'passphrase' : 'PIN';

  // Store the secret first — atomic first-secret setup (DOC-137 §5.4). Re-wraps
  // any pre-existing device-key accounts under the new secret before committing
  // the credential (verify-before-delete), so onboarding never strands keys.
  const setUpSecretAndBiometrics = async () => {
    setSetupStep(`Setting up ${secretLabel}...`);
    await authSetupPin(pin, mode);
    committedSecretRef.current = { secret: pin, mode };

    // Store biometric preference. When the user opts into biometrics at
    // onboarding, capture the just-set PIN behind the write-time auth gate
    // (DOC-137 §3.3) so the biometric-convenience item exists on first launch
    // and biometric unlock can populate the session vault — otherwise the very
    // first biometric unlock would find no item and fall back to PIN. The
    // convenience write is best-effort: if it fails (e.g. the OS auth is
    // cancelled at write), biometrics is left disabled and onboarding proceeds.
    setSetupStep('Configuring security...');
    if (biometricEnabled) {
      try {
        await AccountSecureStorage.setBiometricSecret(
          pin,
          mode,
          'Enable biometric unlock'
        );
        await AccountSecureStorage.setBiometricEnabled(true);
      } catch {
        console.warn('Failed to enable biometric convenience during setup');
        await AccountSecureStorage.setBiometricEnabled(false);
      }
    } else {
      await AccountSecureStorage.setBiometricEnabled(false);
    }
  };

  const handleComplete = async () => {
    if (submittingRef.current) return;
    if (isPassphrase) {
      if (pin.length < PASSPHRASE_MIN) {
        Alert.alert(
          'Error',
          `Passphrase must be at least ${PASSPHRASE_MIN} characters`
        );
        return;
      }
    } else if (!pin || pin.length !== 6) {
      Alert.alert('Error', 'PIN must be 6 digits');
      return;
    }

    if (pin !== confirmPin) {
      Alert.alert(
        'Error',
        isPassphrase ? 'Passphrases do not match' : 'PINs do not match'
      );
      return;
    }

    if (isPhraseSource && !hasStoredMnemonic()) {
      Alert.alert('Error', MNEMONIC_UNAVAILABLE_MESSAGE);
      return;
    }

    // Retry after an import failure: the credential was already committed by
    // this screen. AccountSecureStorage.setupPin is FIRST-secret setup (it
    // rewraps with no current secret and overwrites the credential without
    // verifying the old one), so it must not run again. Require the same
    // secret so the user can't believe a different PIN took effect.
    const committed = committedSecretRef.current;
    if (committed && (committed.secret !== pin || committed.mode !== mode)) {
      const committedLabel =
        committed.mode === 'passphrase' ? 'passphrase' : 'PIN';
      Alert.alert(
        'Error',
        `Your ${committedLabel} is already set. Enter the same ${committedLabel} to continue.`
      );
      return;
    }

    submittingRef.current = true;
    try {
      setSubmitting(true);

      if (!committed) {
        await setUpSecretAndBiometrics();
      }

      // Handle different onboarding sources
      if (isPhraseSource) {
        // Standard wallet creation flow
        setSetupStep('Creating wallet...');
        const normalizedLabel = accountLabel.trim();
        let imported = false;
        try {
          // TASK-224: read the phrase from the in-memory holder at import time.
          // Re-checked here (not just in the pre-check above) because the entry
          // can be cleared while setupPin is awaited. Never import with an
          // empty phrase.
          const mnemonic = mnemonicSecretId
            ? getAccountSecret(mnemonicSecretId)?.mnemonic
            : undefined;
          if (!mnemonic) {
            throw new Error(MNEMONIC_UNAVAILABLE_MESSAGE);
          }
          const importedAccount =
            await MultiAccountWalletService.importStandardAccount({
              type: AccountType.STANDARD,
              mnemonic,
              label: normalizedLabel || 'Main Account',
              // Only the 'create' flow runs the verification quiz; a plain
              // mnemonic import is someone typing in a phrase they already hold
              // elsewhere, which is not a confirmation performed on this device.
              backupVerified:
                source === 'create' && backupVerifiedParam === true,
            });
          imported = true;
          console.log('Successfully created account:', importedAccount.address);
        } finally {
          // Consumed: release it on success. On an import FAILURE keep it so a
          // same-screen retry works; the unmount cleanup still guarantees
          // release. If the screen already unmounted mid-submit (the unmount
          // cleanup skipped it because we were in flight), release it here.
          if (imported || !mountedRef.current) {
            clearAccountSecret(mnemonicSecretId);
          }
        }
      } else if ((source === 'qr' || source === 'watch') && accounts) {
        // QR import or watch account flow - import the scanned accounts
        setSetupStep(
          source === 'qr' ? 'Importing accounts...' : 'Adding watch account...'
        );
        let successCount = 0;
        let failedCount = 0;

        for (const account of accounts) {
          try {
            if (account.type === 'standard') {
              const secret = account.secretId
                ? getAccountSecret(account.secretId)
                : undefined;

              if (!secret || (!secret.mnemonic && !secret.privateKey)) {
                throw new Error('Secure account data unavailable for import');
              }

              const request: ImportAccountRequest = {
                type: AccountType.STANDARD,
                label:
                  account.name ||
                  `Imported Account ${new Date().toLocaleDateString()}`,
              };
              if (secret.mnemonic) {
                request.mnemonic = secret.mnemonic;
              } else if (secret.privateKey) {
                request.privateKey = secret.privateKey;
              }
              await MultiAccountWalletService.importStandardAccount(request);
              clearAccountSecret(account.secretId);
            } else {
              const request: AddWatchAccountRequest = {
                type: AccountType.WATCH,
                address: account.address,
                label:
                  account.name ||
                  `Watch Account ${new Date().toLocaleDateString()}`,
              };
              await MultiAccountWalletService.addWatchAccount(request);
            }
            successCount++;
          } catch (error) {
            console.error(
              `Failed to import account ${redactAddress(account.address)}:`,
              redactError(error)
            );
            failedCount++;
          }
        }

        if (failedCount > 0) {
          Alert.alert(
            'Import Warning',
            `${successCount} accounts imported successfully. ${failedCount} accounts failed to import.`
          );
        }
      } else if (source === 'ledger') {
        // Ledger accounts are already imported prior to security setup
        setSetupStep('Saving security preferences...');
      }

      setSetupStep('Finalizing...');
      committedSecretRef.current = null;
      // Done: drop the in-flight guard before leaving so beforeRemove can't
      // block this navigation.
      submittingRef.current = false;
      navigation.navigate('Main');
    } catch (error) {
      console.error('Security setup error:', error);
      Alert.alert(
        'Error',
        'Failed to setup wallet security: ' +
          (error instanceof Error ? error.message : 'Unknown error')
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setSetupStep('');
    }
  };

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <UniversalHeader
          title="Security Setup"
          showBackButton={!submitting}
          onBackPress={() => {
            if (!submittingRef.current) navigation.goBack();
          }}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />
        <KeyboardAwareScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
        >
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {source === 'qr'
              ? 'Secure your imported accounts with a PIN and optional biometric authentication'
              : source === 'watch'
                ? 'Secure your watch account with a PIN and optional biometric authentication'
                : source === 'ledger'
                  ? 'Secure access to your Ledger accounts with a PIN and optional biometric authentication'
                  : 'Secure your wallet with a PIN and optional biometric authentication'}
          </Text>

          <GlassCard variant="medium" style={styles.formCard}>
            {(source === 'create' || source === 'mnemonic') && (
              <GlassInput
                label="Account Name (optional)"
                placeholder="Wallet account name"
                value={accountLabel}
                onChangeText={setAccountLabel}
                returnKeyType="done"
                autoCapitalize="words"
                autoCorrect={false}
                leftIcon="person-outline"
              />
            )}

            {/* PIN vs passphrase mode toggle. Switching clears the fields so a
                half-typed PIN can't leak into a passphrase submit (or vice-versa). */}
            <View style={styles.modeToggle}>
              {(['pin', 'passphrase'] as const).map((m) => {
                const active = mode === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => {
                      if (mode === m) return;
                      setMode(m);
                      setPin('');
                      setConfirmPin('');
                    }}
                    style={[
                      styles.modeOption,
                      active && {
                        backgroundColor: theme.colors.primary,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.modeOptionText,
                        {
                          color: active
                            ? theme.colors.buttonText
                            : theme.colors.text,
                        },
                      ]}
                    >
                      {m === 'pin' ? '6-digit PIN' : 'Passphrase'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {isPassphrase ? (
              <>
                <GlassInput
                  label={`Create passphrase (min ${PASSPHRASE_MIN} chars)`}
                  placeholder="Enter passphrase"
                  value={pin}
                  onChangeText={setPin}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  leftIcon="key-outline"
                />
                <PassphraseStrengthMeter
                  secret={pin}
                  minLength={PASSPHRASE_MIN}
                />
                <GlassInput
                  label="Confirm passphrase"
                  placeholder="Confirm passphrase"
                  value={confirmPin}
                  onChangeText={setConfirmPin}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  leftIcon="key-outline"
                />
              </>
            ) : (
              <>
                <GlassInput
                  label="Create 6-digit PIN"
                  placeholder="Enter PIN"
                  value={pin}
                  onChangeText={setPin}
                  keyboardType="numeric"
                  maxLength={6}
                  secureTextEntry
                  leftIcon="lock-closed-outline"
                />
                <GlassInput
                  label="Confirm PIN"
                  placeholder="Confirm PIN"
                  value={confirmPin}
                  onChangeText={setConfirmPin}
                  keyboardType="numeric"
                  maxLength={6}
                  secureTextEntry
                  leftIcon="lock-closed-outline"
                />
              </>
            )}

            {biometricAvailable && (
              <View style={styles.biometricContainer}>
                <View style={styles.biometricLeft}>
                  <View
                    style={[
                      styles.biometricIcon,
                      { backgroundColor: `${theme.colors.primary}15` },
                    ]}
                  >
                    <Ionicons
                      name="finger-print"
                      size={20}
                      color={theme.colors.primary}
                    />
                  </View>
                  <Text
                    style={[
                      styles.biometricLabel,
                      { color: theme.colors.text },
                    ]}
                  >
                    Enable Biometric Authentication
                  </Text>
                </View>
                <Switch
                  value={biometricEnabled}
                  onValueChange={setBiometricEnabled}
                  trackColor={{
                    false: theme.colors.border,
                    true: theme.colors.primary,
                  }}
                  thumbColor={theme.colors.buttonText}
                />
              </View>
            )}
          </GlassCard>

          <GlassButton
            variant="primary"
            label={submitting ? setupStep || 'Setting up...' : 'Complete Setup'}
            icon={submitting ? undefined : 'checkmark-circle'}
            loading={submitting}
            disabled={!pin || !confirmPin || submitting}
            onPress={handleComplete}
            fullWidth
            glow
            size="lg"
          />
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
      flexGrow: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
    },
    subtitle: {
      fontSize: theme.typography.body.fontSize,
      marginBottom: theme.spacing.xl,
      textAlign: 'center',
      lineHeight: 22,
    },
    formCard: {
      borderRadius: theme.borderRadius.xxl,
      marginBottom: theme.spacing.xl,
      gap: theme.spacing.md,
    },
    modeToggle: {
      flexDirection: 'row',
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.glassBorder,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.xs,
    },
    modeOption: {
      flex: 1,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
    },
    modeOptionText: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '600',
    },
    biometricContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: theme.spacing.md,
      marginTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.glassBorder,
    },
    biometricLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    biometricIcon: {
      width: 36,
      height: 36,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spacing.md,
    },
    biometricLabel: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '500',
      flex: 1,
    },
  });

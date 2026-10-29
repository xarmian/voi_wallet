import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  StyleSheet,
} from 'react-native';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { reviewGrant } from '@/services/auth/reviewGrant';
import { safeDappText } from '@/utils/signingSummary';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import {
  useAppSwitcherProtection,
  useSecureScreen,
} from '@/hooks/useSecureScreen';
import { Theme } from '@/constants/themes';

export interface RequestDapp {
  name?: string;
  url?: string;
  icon?: string;
}
export function dappHost(dapp?: RequestDapp): string {
  try {
    return new URL(dapp?.url ?? '').hostname || 'Unknown website';
  } catch {
    return 'Unknown website';
  }
}

export default function LockedRequestGate({
  requestKey,
  dapp,
  network,
  biometricEnabled,
  onReject,
}: {
  requestKey: string;
  dapp?: RequestDapp;
  network: string;
  biometricEnabled: boolean;
  onReject: () => void;
}) {
  // TASK-437 (Luna P2): keep the gate (and the PIN entry on it) out of
  // screenshots and the app-switcher snapshot.
  useSecureScreen();
  useAppSwitcherProtection();
  const styles = useThemedStyles(createStyles);
  const [credential, setCredential] = useState('');
  const [source, setSource] = useState<'pin' | 'passphrase'>('pin');
  const [entering, setEntering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    AccountSecureStorage.getCredentialSource()
      .then((value) => setSource(value ?? 'pin'))
      .catch(() => {});
  }, []);
  const unlock = async (biometric: boolean) => {
    setBusy(true);
    setError('');
    try {
      const ok = await reviewGrant.unlock(
        requestKey,
        biometric ? { biometric: true } : { pin: credential }
      );
      if (!ok) {
        setEntering(true);
        setError(
          'Authentication failed or cancelled. Use your wallet PIN or passphrase, or try again later.'
        );
      }
    } catch {
      setEntering(true);
      setError('Unable to authenticate. Please try again.');
    } finally {
      setBusy(false);
      setCredential('');
    }
  };
  return (
    <View style={styles.container}>
      {dapp?.icon?.startsWith('https://') && (
        <Image
          source={{ uri: dapp.icon }}
          style={styles.icon}
          accessibilityIgnoresInvertColors
        />
      )}
      <Text style={styles.title}>WalletConnect request</Text>
      <Text style={styles.text}>
        {safeDappText(dapp?.name ?? '') || 'Unknown dApp'}
      </Text>
      <Text style={styles.text}>{dappHost(dapp)}</Text>
      <Text style={styles.text}>{network}</Text>
      <Text style={styles.text}>
        Unlock to review this request. Your wallet will stay locked.
      </Text>
      {entering && (
        <TextInput
          accessibilityLabel={
            source === 'passphrase' ? 'Wallet passphrase' : 'Wallet PIN'
          }
          placeholder={
            source === 'passphrase' ? 'Wallet passphrase' : 'Wallet PIN'
          }
          value={credential}
          onChangeText={setCredential}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={source === 'pin' ? 'number-pad' : 'default'}
          maxLength={source === 'pin' ? 6 : undefined}
          style={styles.input}
          editable={!busy}
        />
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.text}>
          {error}
        </Text>
      )}
      <TouchableOpacity
        style={styles.button}
        disabled={busy}
        onPress={() => {
          if (!entering && !biometricEnabled) {
            setEntering(true);
            return;
          }
          void unlock(!entering && biometricEnabled);
        }}
      >
        <Text style={styles.buttonText}>
          {busy ? 'Authenticating…' : 'Unlock to review'}
        </Text>
      </TouchableOpacity>
      {biometricEnabled && !entering && (
        <TouchableOpacity
          style={styles.button}
          disabled={busy}
          onPress={() => setEntering(true)}
        >
          <Text style={styles.buttonText}>
            Use {source === 'passphrase' ? 'passphrase' : 'PIN'}
          </Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.button} onPress={onReject}>
        <Text style={styles.buttonText}>Reject</Text>
      </TouchableOpacity>
    </View>
  );
}
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, padding: 24, justifyContent: 'center', gap: 16 },
    icon: { width: 48, height: 48, alignSelf: 'center' },
    title: { fontSize: 22, fontWeight: '600', color: theme.colors.text },
    text: { fontSize: 16, color: theme.colors.text },
    input: {
      color: theme.colors.text,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      borderRadius: 8,
      padding: 16,
    },
    button: {
      padding: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.primary,
    },
    buttonText: {
      color: theme.colors.buttonText,
      textAlign: 'center',
      fontWeight: '600',
    },
  });

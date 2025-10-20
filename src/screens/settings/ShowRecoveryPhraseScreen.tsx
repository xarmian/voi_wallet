import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useNavigation, useRoute } from '@react-navigation/native';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { useActiveAccount } from '@/store/walletStore';
import MnemonicDisplay from '@/components/wallet/MnemonicDisplay';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface RouteParams {
  accountAddress?: string;
}

export default function ShowRecoveryPhraseScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { accountAddress } = (route.params as RouteParams) ?? {};
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const activeAccount = useActiveAccount();
  const targetAddress = accountAddress ?? activeAccount?.address;

  const [mnemonic, setMnemonic] = useState<string>('');
  const [mnemonicWords, setMnemonicWords] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBlurred, setIsBlurred] = useState(true);
  const [hasCopied, setHasCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout>();

  const loadMnemonic = useCallback(async () => {
    if (!targetAddress) {
      Alert.alert('Error', 'No account selected');
      navigation.goBack();
      return;
    }

    setIsLoading(true);
    try {
      const recoveredMnemonic =
        await SecureKeyManager.getMnemonic(targetAddress);
      setMnemonic(recoveredMnemonic);
      setMnemonicWords(recoveredMnemonic.split(' '));
    } catch (error) {
      console.error('Failed to load mnemonic:', error);

      let errorMessage =
        'Failed to retrieve recovery phrase. Please try again.';
      const errorStr = error instanceof Error ? error.message : String(error);

      if (
        errorStr.includes('not found') ||
        errorStr.includes('Account not found')
      ) {
        errorMessage = 'Account not found. Please select a valid account.';
      } else if (errorStr.includes('No active account')) {
        errorMessage =
          'No active account found. Please select an account first.';
      } else if (errorStr.includes('not have a recovery phrase')) {
        errorMessage = 'This account type does not have a recovery phrase.';
      }

      Alert.alert('Error', errorMessage, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [targetAddress, navigation]);

  // Load mnemonic immediately when component mounts but keep it blurred
  useEffect(() => {
    loadMnemonic();
  }, [loadMnemonic]);

  const handleCopy = useCallback(async () => {
    if (!mnemonic) return;

    try {
      await Clipboard.setStringAsync(mnemonic);
      setHasCopied(true);
      Alert.alert('Copied!', 'Recovery phrase copied to clipboard');

      // Reset the copied state after 3 seconds
      timeoutRef.current = setTimeout(() => setHasCopied(false), 3000);
    } catch (error) {
      Alert.alert('Error', 'Failed to copy to clipboard');
    }
  }, [mnemonic]);

  const handleShare = useCallback(async () => {
    if (!mnemonic) return;

    Alert.alert(
      'Security Warning',
      'Sharing your recovery phrase through system sharing may not be secure. This could expose your phrase to other apps or cloud services. Are you sure you want to continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Share Anyway',
          style: 'destructive',
          onPress: async () => {
            try {
              await Share.share({
                message: `Voi Wallet Recovery Phrase:\n\n${mnemonic}\n\nKeep this phrase safe and never share it with anyone you don't trust.`,
                title: 'Voi Wallet Recovery Phrase',
              });
            } catch (error) {
              console.error('Failed to share:', error);
            }
          },
        },
      ]
    );
  }, [mnemonic]);

  const toggleReveal = useCallback(() => {
    setIsBlurred(!isBlurred);
  }, [isBlurred]);

  // Cleanup sensitive data and timeouts when component unmounts
  useEffect(() => {
    return () => {
      // Clear sensitive data when component unmounts
      setMnemonic('');
      setMnemonicWords([]);

      // Clear any pending timeouts
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={24} color={theme.colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Recovery Phrase</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.warningContainer}>
          <Ionicons name="warning" size={24} color={theme.colors.warning} />
          <Text style={styles.warningText}>
            Your recovery phrase is the master key to your wallet. Never share
            it with anyone.
          </Text>
        </View>

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.loadingText}>Loading recovery phrase...</Text>
          </View>
        ) : (
          <>
            <View style={styles.mnemonicContainer}>
              <MnemonicDisplay
                mnemonic={mnemonic}
                isBlurred={isBlurred}
                onToggleReveal={toggleReveal}
                showRevealButton={true}
                layout="grid"
              />
            </View>

            {!isBlurred && (
              <View style={styles.actionContainer}>
                <TouchableOpacity
                  style={[
                    styles.actionButton,
                    hasCopied && styles.copiedButton,
                  ]}
                  onPress={handleCopy}
                >
                  <Ionicons
                    name={hasCopied ? 'checkmark' : 'copy'}
                    size={20}
                    color="white"
                  />
                  <Text style={styles.actionButtonText}>
                    {hasCopied ? 'Copied!' : 'Copy to Clipboard'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionButton, styles.shareButton]}
                  onPress={handleShare}
                >
                  <Ionicons
                    name="share"
                    size={20}
                    color={theme.colors.primary}
                  />
                  <Text
                    style={[styles.actionButtonText, styles.shareButtonText]}
                  >
                    Share
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.securityTipsContainer}>
              <Text style={styles.securityTipsTitle}>Security Tips:</Text>
              <Text style={styles.securityTip}>
                • Write down your phrase on paper and store it safely
              </Text>
              <Text style={styles.securityTip}>
                • Never store it digitally or take screenshots
              </Text>
              <Text style={styles.securityTip}>
                • Keep multiple copies in separate secure locations
              </Text>
              <Text style={styles.securityTip}>
                • Never share your phrase with anyone
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
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
    backButton: {
      padding: theme.spacing.sm,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 40,
    },
    content: {
      padding: theme.spacing.lg,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(255, 159, 10, 0.1)' : '#FFF3CD',
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.lg,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.warning,
    },
    warningText: {
      flex: 1,
      marginLeft: theme.spacing.sm,
      fontSize: 14,
      color: theme.mode === 'dark' ? theme.colors.warning : '#856404',
      fontWeight: '500',
    },
    loadingContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xxl,
    },
    loadingText: {
      marginTop: theme.spacing.sm,
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    mnemonicContainer: {
      paddingBottom: theme.spacing.lg,
    },
    actionContainer: {
      flexDirection: 'row',
      gap: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    actionButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
    },
    copiedButton: {
      backgroundColor: theme.colors.success,
    },
    shareButton: {
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    actionButtonText: {
      marginLeft: theme.spacing.sm,
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    shareButtonText: {
      color: theme.colors.primary,
    },
    securityTipsContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
    },
    securityTipsTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    securityTip: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginBottom: 6,
      lineHeight: 20,
    },
  });

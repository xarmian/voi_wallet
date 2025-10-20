import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type OnboardingScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'Onboarding'
>;

interface Props {
  navigation: OnboardingScreenNavigationProp;
}

export default function OnboardingScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const accountOptions = [
    {
      id: 'create',
      title: 'Create New Account',
      subtitle: 'Generate a new account and backup its recovery phrase',
      icon: 'add-circle-outline' as const,
      onPress: () => navigation.navigate('CreateWallet'),
    },
    {
      id: 'import',
      title: 'Import Account',
      subtitle: 'Import existing account with seed phrase',
      icon: 'download-outline' as const,
      onPress: () =>
        navigation.navigate('MnemonicImport', { isOnboarding: true }),
    },
    {
      id: 'ledger',
      title: 'Connect Ledger',
      subtitle: 'Import accounts secured with your Ledger hardware wallet',
      icon: 'hardware-chip-outline' as const,
      onPress: () =>
        navigation.navigate('LedgerAccountImport', { isOnboarding: true }),
    },
    {
      id: 'importQR',
      title: 'Import via QR Code',
      subtitle: 'Scan QR codes to import multiple accounts',
      icon: 'qr-code-outline' as const,
      onPress: () => navigation.navigate('QRAccountImport'),
    },
    {
      id: 'watch',
      title: 'Add Watch Account',
      subtitle: 'Monitor an account without private key access',
      icon: 'eye-outline' as const,
      onPress: () =>
        navigation.navigate('AddWatchAccount', { isOnboarding: true }),
    },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Welcome to Voi Wallet</Text>
          <Text style={styles.subtitle}>
            Your secure gateway to the Voi Network. Choose how you want to get
            started.
          </Text>
        </View>

        <View style={styles.optionsContainer}>
          {accountOptions.map((option) => (
            <TouchableOpacity
              key={option.id}
              style={styles.optionButton}
              onPress={option.onPress}
              activeOpacity={0.7}
            >
              <View style={styles.optionIcon}>
                <Ionicons
                  name={option.icon}
                  size={24}
                  color={theme.colors.primary}
                />
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle}>{option.title}</Text>
                <Text style={styles.optionSubtitle}>{option.subtitle}</Text>
              </View>
              <Ionicons
                name="chevron-forward"
                size={20}
                color={theme.colors.textMuted}
              />
            </TouchableOpacity>
          ))}
        </View>
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
    content: {
      flexGrow: 1,
      justifyContent: 'center',
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    header: {
      alignItems: 'center',
      marginBottom: theme.spacing.xxl,
    },
    title: {
      fontSize: 32,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
    },
    optionsContainer: {
      gap: theme.spacing.md,
    },
    optionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.xl,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      ...theme.shadows.sm,
    },
    optionIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(10, 132, 255, 0.1)' : '#EBF4FF',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    optionContent: {
      flex: 1,
    },
    optionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 4,
    },
    optionSubtitle: {
      fontSize: 14,
      color: theme.colors.textMuted,
      lineHeight: 18,
    },
  });

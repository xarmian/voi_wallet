import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RootStackParamList } from '@/navigation/AppNavigator';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';

type PairingScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'WalletConnectPairing'
>;
type PairingScreenRouteProp = RouteProp<RootStackParamList, 'WalletConnectPairing'>;

interface Props {
  navigation: PairingScreenNavigationProp;
  route: PairingScreenRouteProp;
}

export default function WalletConnectPairingScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const uri = route.params?.uri;

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader title="WalletConnect" showBackButton onBackPress={() => navigation.goBack()} />
        <View style={styles.content}>
          <GlassCard variant="medium" style={styles.card}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.title, { marginTop: 16 }]}>Connecting…</Text>
            <Text style={styles.message}>
              {uri ? 'Waiting for session proposal from dApp…' : 'Waiting for WalletConnect…'}
            </Text>
          </GlassCard>
        </View>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    content: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
    },
    card: {
      alignItems: 'center',
      padding: theme.spacing.xl,
      borderRadius: theme.borderRadius.xxl,
    },
    title: {
      fontSize: theme.typography.heading3.fontSize,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    message: {
      marginTop: theme.spacing.sm,
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
  });



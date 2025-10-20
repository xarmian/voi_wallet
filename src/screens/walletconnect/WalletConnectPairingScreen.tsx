import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';

import { RootStackParamList } from '@/navigation/AppNavigator';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

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
    <View style={styles.container}>
      <UniversalHeader title="WalletConnect" showBackButton onBackPress={() => navigation.goBack()} />
      <View style={styles.content}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={[styles.title, { marginTop: 12 }]}>Connecting…</Text>
        <Text style={styles.message}>
          {uri ? 'Waiting for session proposal from dApp…' : 'Waiting for WalletConnect…'}
        </Text>
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    message: {
      marginTop: 8,
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
  });



import React from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { WalletStackParamList } from '@/navigation/AppNavigator';
import { GlassCard } from '@/components/common/GlassCard';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useControlledByNotice } from '@/store/useControlledByNotice';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import { formatAddress } from '@/utils/address';
import { copyToClipboard } from '@/utils/clipboard';

export default function ControlledByNotice() {
  const notices = useControlledByNotice();
  const navigation =
    useNavigation<NativeStackNavigationProp<WalletStackParamList>>();
  const styles = useThemedStyles(createStyles);
  return (
    <>
      {notices.map(({ address, networks, showNetworks }) => {
        const message = `This account is controlled by ${formatAddress(address)}, and that key hasn't been backed up yet.${showNetworks ? ` (${networks.map((n) => NETWORK_CONFIGURATIONS[n].name).join(', ')})` : ''}`;
        return (
          <GlassCard key={address} variant="light" style={styles.card}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={message}
              accessibilityHint="Back up the controlling account"
              onPress={() =>
                navigation.navigate('VerifyBackup', { accountAddress: address })
              }
            >
              <Text style={styles.message}>{message}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Copy controlling address ${address}`}
              onPress={() =>
                void copyToClipboard(address, 'Address copied to clipboard')
              }
            >
              <Text style={styles.copy}>Copy address</Text>
            </TouchableOpacity>
          </GlassCard>
        );
      })}
    </>
  );
}
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      marginBottom: theme.spacing.md,
      borderRadius: theme.borderRadius.xl,
    },
    message: {
      color: theme.colors.text,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 18,
    },
    copy: { color: theme.colors.primary, paddingVertical: theme.spacing.sm },
  });

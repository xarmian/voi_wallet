import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { truncateAddress } from '@/services/walletconnect/utils';
import { TransactionDangers } from '@/utils/transactionDangers';

interface Props {
  dangers: TransactionDangers; // aggregated
  acknowledged: boolean;
  onToggleAcknowledged: () => void;
}

/**
 * Presentational danger banner for authority-transfer / balance-sweep fields
 * (S-01). Renders a prominent error-colored warning for each present danger and
 * an acknowledgment checkbox. All gating/state is owned by the parent screen.
 */
export default function TransactionDangerBanner({
  dangers,
  acknowledged,
  onToggleAcknowledged,
}: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons
          name="alert-circle"
          size={24}
          color={theme.colors.error}
        />
        <Text style={styles.headerText}>
          Dangerous operation — review carefully
        </Text>
      </View>

      {dangers.rekeyTo ? (
        <Text style={styles.dangerLine}>
          This REKEYS your account: signing authority is transferred to{' '}
          {truncateAddress(dangers.rekeyTo)}. Whoever controls that address
          controls your account.
        </Text>
      ) : null}

      {dangers.closeRemainderTo ? (
        <Text style={styles.dangerLine}>
          This CLOSES your account: your entire remaining balance is sent to{' '}
          {truncateAddress(dangers.closeRemainderTo)}.
        </Text>
      ) : null}

      {dangers.assetCloseTo ? (
        <Text style={styles.dangerLine}>
          This CLOSES OUT the asset: your entire remaining asset balance is sent
          to {truncateAddress(dangers.assetCloseTo)}.
        </Text>
      ) : null}

      <TouchableOpacity
        style={styles.acknowledgeRow}
        onPress={onToggleAcknowledged}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        accessibilityLabel="Acknowledge dangerous transaction warning"
        activeOpacity={0.7}
      >
        <Ionicons
          name={acknowledged ? 'checkbox' : 'square-outline'}
          size={24}
          color={theme.colors.error}
        />
        <Text style={styles.acknowledgeText}>
          I understand this transfers control of / drains my account and want to
          proceed.
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255,69,58,0.08)'
          : 'rgba(255,69,58,0.15)',
      borderWidth: 2,
      borderColor: theme.colors.error,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
    },
    headerText: {
      flex: 1,
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.error,
      marginLeft: 10,
    },
    dangerLine: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
      lineHeight: 20,
      marginBottom: 10,
    },
    acknowledgeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 4,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: theme.colors.error + '40',
    },
    acknowledgeText: {
      flex: 1,
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginLeft: 10,
      lineHeight: 20,
    },
  });

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { DangerItem } from '@/utils/transactionDangers';

interface Props {
  /** Every dangerous operation in the batch, with its transaction index. */
  dangers: (DangerItem & { txnIndex: number })[];
  acknowledged: boolean;
  onToggleAcknowledged: () => void;
}

const UNVERIFIED =
  " This could not be checked against the asset's settings at this point in the batch, so it may change nothing (unverified).";

/**
 * What one dangerous operation does. Every address, the affected account
 * included, is shown in full: a truncated address can be matched by an
 * attacker's vanity address (TASK-440 Luna r1 #4).
 */
export function describeDanger(item: DangerItem): string {
  const account = item.sender ?? 'an unknown account';
  switch (item.kind) {
    case 'rekey':
      return `REKEYS ${account}: signing authority is transferred to ${item.target}. Whoever controls that address controls the account.`;
    case 'closeAccount':
      return `CLOSES ${account}: its entire remaining balance is sent to ${item.target}.`;
    case 'closeAsset':
      return `CLOSES OUT an asset held by ${account}: the entire remaining asset balance is sent to ${item.target}.`;
    case 'clawback':
      return `CLAWBACK: ${account} uses its clawback authority over asset #${item.assetId} to take holdings from ${item.from}${item.target ? ` and send them to ${item.target}` : ''}.`;
    case 'assetAuthority':
      return `${account} gives the ${item.role} authority of asset #${item.assetId} to ${item.target}.${item.unverified ? UNVERIFIED : ''}`;
    case 'assetAuthorityRemoved':
      return `${account} permanently REMOVES the ${item.role} authority of asset #${item.assetId}.${item.unverified ? UNVERIFIED : ''}`;
    case 'assetDestroy':
      return `${account} DESTROYS asset #${item.assetId}.`;
  }
}

/**
 * Presentational danger banner (S-01, TASK-440 audit #1/#2): one line for EVERY
 * dangerous operation in the batch, each naming its transaction, plus an
 * acknowledgment checkbox. All gating/state is owned by the parent screen.
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
        <Ionicons name="alert-circle" size={24} color={theme.colors.error} />
        <Text style={styles.headerText}>
          Dangerous operation — review carefully
        </Text>
      </View>

      {dangers.map((item, index) => (
        <Text key={index} style={styles.dangerLine} selectable>
          Transaction {item.txnIndex + 1}: {describeDanger(item)}
        </Text>
      ))}

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
          I understand what these operations do and want to proceed.
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

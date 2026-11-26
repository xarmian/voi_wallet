import React from 'react';
import { Text, View } from 'react-native';
import { GlassButton } from '@/components/common/GlassButton';
import { useTheme } from '@/contexts/ThemeContext';
import { useMessagingSigner } from './useMessagingSigner';

export function MessagingSignerNotice({
  signer,
}: {
  signer: ReturnType<typeof useMessagingSigner>;
}) {
  const { theme } = useTheme();
  if (signer.status === 'loading' || signer.canUseMessaging) return null;
  return (
    <View style={{ padding: theme.spacing.md }}>
      <Text style={{ color: theme.colors.text }}>
        {signer.status === 'error'
          ? 'Unable to verify messaging signer. Please try again.'
          : signer.isLedgerBacked
            ? 'Encrypted messaging is not available for Ledger accounts. Please switch to a standard account.'
            : 'Encrypted messaging requires this account’s secret key and a held software signing key on Voi.'}
      </Text>
      {signer.status === 'error' && (
        <GlassButton label="Retry" onPress={signer.retry} />
      )}
    </View>
  );
}

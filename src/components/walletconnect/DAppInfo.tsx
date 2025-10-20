import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { WalletConnectMetadata } from '@/services/walletconnect/types';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface Props {
  metadata: WalletConnectMetadata;
  showDescription?: boolean;
  compact?: boolean;
}

export default function DAppInfo({
  metadata,
  showDescription = true,
  compact = false,
}: Props) {
  const iconSize = compact ? 32 : 48;
  const nameSize = compact ? 14 : 16;
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={[styles.container, compact && styles.compact]}>
      {metadata.icons.length > 0 && (
        <Image
          source={{ uri: metadata.icons[0] }}
          style={[styles.icon, { width: iconSize, height: iconSize }]}
          defaultSource={require('../../../assets/icon.png')}
        />
      )}
      <View style={styles.info}>
        <Text style={[styles.name, { fontSize: nameSize }]} numberOfLines={1}>
          {metadata.name}
        </Text>
        {metadata.url && (
          <Text
            style={[styles.url, compact && styles.urlCompact]}
            numberOfLines={1}
          >
            {metadata.url}
          </Text>
        )}
        {showDescription && metadata.description && !compact && (
          <Text style={styles.description} numberOfLines={2}>
            {metadata.description}
          </Text>
        )}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    compact: {
      alignItems: 'center',
    },
    icon: {
      borderRadius: 8,
      marginRight: 12,
    },
    info: {
      flex: 1,
    },
    name: {
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    url: {
      fontSize: 12,
      color: theme.colors.primary,
      marginBottom: 4,
    },
    urlCompact: {
      fontSize: 10,
    },
    description: {
      fontSize: 12,
      color: theme.colors.textMuted,
      lineHeight: 16,
    },
  });

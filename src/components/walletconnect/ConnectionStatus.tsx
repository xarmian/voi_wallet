import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface Props {
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  sessionCount?: number;
  compact?: boolean;
}

export default function ConnectionStatus({
  status,
  sessionCount,
  compact = false,
}: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const getStatusColor = () => {
    switch (status) {
      case 'connected':
        return theme.colors.success;
      case 'connecting':
        return theme.colors.warning;
      case 'disconnected':
        return theme.colors.textMuted;
      case 'error':
        return theme.colors.error;
      default:
        return theme.colors.textMuted;
    }
  };

  const getStatusIcon = () => {
    switch (status) {
      case 'connected':
        return 'checkmark-circle';
      case 'connecting':
        return 'time';
      case 'disconnected':
        return 'close-circle';
      case 'error':
        return 'warning';
      default:
        return 'close-circle';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return sessionCount && sessionCount > 0
          ? `${sessionCount} dApp${sessionCount > 1 ? 's' : ''} connected`
          : 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'disconnected':
        return 'Not connected';
      case 'error':
        return 'Connection error';
      default:
        return 'Unknown status';
    }
  };

  const statusColor = getStatusColor();
  const iconSize = compact ? 16 : 20;
  const textSize = compact ? 12 : 14;

  return (
    <View style={[styles.container, compact && styles.compact]}>
      <Ionicons name={getStatusIcon()} size={iconSize} color={statusColor} />
      <Text
        style={[
          styles.text,
          { color: statusColor, fontSize: textSize },
          compact && styles.textCompact,
        ]}
      >
        {getStatusText()}
      </Text>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 16,
      backgroundColor: theme.colors.surfaceVariant,
    },
    compact: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 12,
    },
    text: {
      fontWeight: '500',
      marginLeft: 6,
    },
    textCompact: {
      fontWeight: '400',
    },
  });

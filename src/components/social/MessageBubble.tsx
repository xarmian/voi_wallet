import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Pressable,
  Linking,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import { Message, MessageStatus, MESSAGE_FEE_MICRO } from '@/services/messaging/types';

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  onRetry?: (message: Message) => void;
}

export default function MessageBubble({ message, isOwn, onRetry }: MessageBubbleProps) {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const networkConfig = useCurrentNetworkConfig();
  const [showDetails, setShowDetails] = useState(false);

  const isFailed = message.status === 'failed';
  const isPending = message.status === 'pending';
  const isConfirmed = message.status === 'confirmed';
  const errorColor = theme.colors.error || '#EF4444';

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderStatusIcon = () => {
    if (!isOwn) return null;

    switch (message.status) {
      case 'pending':
        return (
          <ActivityIndicator
            size={10}
            color="rgba(255,255,255,0.7)"
            style={styles.statusIcon}
          />
        );
      case 'confirmed':
        return (
          <Ionicons
            name="checkmark"
            size={12}
            color="rgba(255,255,255,0.7)"
            style={styles.statusIcon}
          />
        );
      case 'failed':
        return (
          <Ionicons
            name="alert-circle"
            size={12}
            color={errorColor}
            style={styles.statusIcon}
          />
        );
      default:
        return null;
    }
  };

  const handleRetry = () => {
    if (onRetry) {
      onRetry(message);
    }
  };

  const handleBubblePress = useCallback(() => {
    // Don't show details for pending or failed messages
    if (isPending || isFailed) return;
    setShowDetails((prev) => !prev);
  }, [isPending, isFailed]);

  const handleOpenExplorer = useCallback(() => {
    const explorerUrl = networkConfig?.blockExplorerUrl;
    if (!explorerUrl || !message.id) {
      Alert.alert('Unavailable', 'Cannot open explorer for this message.');
      return;
    }

    // Transaction ID - skip if it's a pending/temp ID
    if (message.id.startsWith('pending-')) {
      Alert.alert('Unavailable', 'This message is not yet confirmed on the blockchain.');
      return;
    }

    const url = `${explorerUrl.replace(/\/$/, '')}/explorer/transaction/${message.id}`;
    Linking.openURL(url).catch((error) => {
      console.error('Failed to open explorer:', error);
      Alert.alert('Error', 'Unable to open explorer link.');
    });
  }, [networkConfig?.blockExplorerUrl, message.id]);

  const handleCopyTxId = useCallback(async () => {
    if (!message.id || message.id.startsWith('pending-')) {
      Alert.alert('Unavailable', 'No transaction ID available.');
      return;
    }

    try {
      await Clipboard.setStringAsync(message.id);
      Alert.alert('Copied', 'Transaction ID copied to clipboard');
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  }, [message.id]);

  const handleCopyMessage = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(message.content);
      Alert.alert('Copied', 'Message copied to clipboard');
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  }, [message.content]);

  const formatFullDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  const formatFee = (fee?: number): string => {
    const feeValue = fee || MESSAGE_FEE_MICRO;
    return `${(feeValue / 1_000_000).toFixed(6)} VOI`;
  };

  return (
    <View style={[styles.container, isOwn ? styles.containerOwn : styles.containerOther]}>
      {/* Failed message indicator with retry button */}
      {isFailed && isOwn && (
        <TouchableOpacity
          style={styles.retryButton}
          onPress={handleRetry}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={18} color={errorColor} />
        </TouchableOpacity>
      )}

      <View style={styles.bubbleWrapper}>
        <Pressable
          onPress={handleBubblePress}
          style={[
            styles.bubble,
            isOwn
              ? [styles.bubbleOwn, { backgroundColor: isFailed ? errorColor : theme.colors.primary }]
              : [styles.bubbleOther, { backgroundColor: theme.colors.surface + 'E0' }],
          ]}
        >
          <Text
            style={[
              styles.messageText,
              isOwn ? styles.messageTextOwn : styles.messageTextOther,
            ]}
          >
            {message.content}
          </Text>
          <View style={styles.footer}>
            <Text
              style={[
                styles.timestamp,
                isOwn ? styles.timestampOwn : styles.timestampOther,
              ]}
            >
              {formatTime(message.timestamp)}
            </Text>
            {renderStatusIcon()}
          </View>
          {isFailed && isOwn && (
            <Text style={styles.failedText}>Failed to send. Tap to retry.</Text>
          )}
        </Pressable>

        {/* Details panel */}
        {showDetails && isConfirmed && (
          <View
            style={[
              styles.detailsPanel,
              isOwn ? styles.detailsPanelOwn : styles.detailsPanelOther,
              { backgroundColor: theme.colors.surface + 'F0' },
            ]}
          >
            {/* Metadata */}
            <View style={styles.detailsRow}>
              <Text style={[styles.detailsLabel, { color: theme.colors.textMuted }]}>
                Time
              </Text>
              <Text style={[styles.detailsValue, { color: theme.colors.text }]}>
                {formatFullDate(message.timestamp)}
              </Text>
            </View>

            {message.fee && (
              <View style={styles.detailsRow}>
                <Text style={[styles.detailsLabel, { color: theme.colors.textMuted }]}>
                  Fee
                </Text>
                <Text style={[styles.detailsValue, { color: theme.colors.text }]}>
                  {formatFee(message.fee)}
                </Text>
              </View>
            )}

            {message.confirmedRound && (
              <View style={styles.detailsRow}>
                <Text style={[styles.detailsLabel, { color: theme.colors.textMuted }]}>
                  Block
                </Text>
                <Text style={[styles.detailsValue, { color: theme.colors.text }]}>
                  {message.confirmedRound.toLocaleString()}
                </Text>
              </View>
            )}

            {/* Action buttons */}
            <View style={styles.detailsActions}>
              <TouchableOpacity
                style={[styles.detailsButton, { backgroundColor: theme.colors.primary + '20' }]}
                onPress={handleOpenExplorer}
              >
                <Ionicons name="open-outline" size={14} color={theme.colors.primary} />
                <Text style={[styles.detailsButtonText, { color: theme.colors.primary }]}>
                  Explorer
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.detailsButton, { backgroundColor: theme.colors.primary + '20' }]}
                onPress={handleCopyTxId}
              >
                <Ionicons name="copy-outline" size={14} color={theme.colors.primary} />
                <Text style={[styles.detailsButtonText, { color: theme.colors.primary }]}>
                  Copy TX ID
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.detailsButton, { backgroundColor: theme.colors.primary + '20' }]}
                onPress={handleCopyMessage}
              >
                <Ionicons name="document-outline" size={14} color={theme.colors.primary} />
                <Text style={[styles.detailsButtonText, { color: theme.colors.primary }]}>
                  Copy Text
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      marginVertical: 2,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    containerOwn: {
      justifyContent: 'flex-end',
    },
    containerOther: {
      justifyContent: 'flex-start',
    },
    retryButton: {
      padding: theme.spacing.sm,
      marginRight: theme.spacing.xs,
      marginTop: theme.spacing.xs,
    },
    bubbleWrapper: {
      maxWidth: '80%',
    },
    bubble: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderRadius: 18,
    },
    bubbleOwn: {
      borderBottomRightRadius: 4,
    },
    bubbleOther: {
      borderBottomLeftRadius: 4,
    },
    messageText: {
      fontSize: 15,
      lineHeight: 20,
    },
    messageTextOwn: {
      color: 'white',
    },
    messageTextOther: {
      color: theme.colors.text,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      marginTop: 4,
      gap: 4,
    },
    timestamp: {
      fontSize: 10,
    },
    timestampOwn: {
      color: 'rgba(255,255,255,0.7)',
    },
    timestampOther: {
      color: theme.colors.textMuted,
    },
    statusIcon: {
      marginLeft: 2,
    },
    failedText: {
      fontSize: 10,
      color: 'rgba(255,255,255,0.8)',
      marginTop: 4,
      fontStyle: 'italic',
    },
    // Details panel styles
    detailsPanel: {
      marginTop: theme.spacing.xs,
      padding: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
    },
    detailsPanelOwn: {
      borderTopRightRadius: 4,
    },
    detailsPanelOther: {
      borderTopLeftRadius: 4,
    },
    detailsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    detailsLabel: {
      fontSize: 11,
      fontWeight: '500',
    },
    detailsValue: {
      fontSize: 11,
    },
    detailsActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.xs,
      marginTop: theme.spacing.sm,
    },
    detailsButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      borderRadius: theme.borderRadius.sm,
    },
    detailsButtonText: {
      fontSize: 11,
      fontWeight: '600',
    },
  });

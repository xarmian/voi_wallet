import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { GlassCard } from '@/components/common/GlassCard';
import { Theme } from '@/constants/themes';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatAddress } from '@/utils/address';

interface RemovedAccountNoticeProps {
  label: string;
  address: string;
  onReimport: () => void;
  onDismiss: () => void;
}

const BODY =
  "This device could no longer read this account's key, so the account was removed from your list. Your funds on the network are not affected. Re-import the account's recovery phrase to bring it back. Without the recovery phrase, this device can't reach those funds.";

export default function RemovedAccountNotice({
  label,
  address,
  onReimport,
  onDismiss,
}: RemovedAccountNoticeProps) {
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const shortAddress = formatAddress(address);
  const name = label ? `${label} (${shortAddress})` : shortAddress;
  const title = `${name} was removed from this device`;

  return (
    <Animated.View
      entering={
        reducedMotion ? undefined : FadeInDown.duration(400).springify()
      }
      exiting={reducedMotion ? undefined : FadeOutUp.duration(300)}
      style={styles.container}
    >
      <GlassCard variant="medium" padding="md">
        <View style={styles.content}>
          <View style={styles.textContainer}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.body}>{BODY}</Text>
          </View>
          <TouchableOpacity
            testID="removed-account-dismiss"
            onPress={onDismiss}
            style={styles.dismissButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss notice"
          >
            <Ionicons name="close" size={20} color={styles.dismissIcon.color} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={onReimport}
          style={styles.reimportButton}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Re-import</Text>
        </TouchableOpacity>
      </GlassCard>
    </Animated.View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { marginBottom: 16 },
    content: { flexDirection: 'row', alignItems: 'flex-start' },
    textContainer: { flex: 1 },
    title: {
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: '600',
      marginBottom: 6,
    },
    body: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 },
    dismissButton: { padding: 4, marginLeft: 8 },
    dismissIcon: { color: theme.colors.textMuted },
    reimportButton: {
      alignSelf: 'flex-start',
      marginTop: 12,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 18,
      backgroundColor: theme.colors.primary,
    },
    buttonText: { color: '#FFFFFF', fontWeight: '600' },
  });

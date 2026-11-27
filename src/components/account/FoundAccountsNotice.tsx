import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { GlassCard } from '@/components/common/GlassCard';
import { Theme } from '@/constants/themes';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatAddress } from '@/utils/address';

interface FoundAccountsNoticeProps {
  count: number;
  /** Shown when exactly one account was found and its address is known. */
  address?: string;
  onReview: () => void;
  onDismiss: () => void;
}

const BODY =
  "Keys for accounts that aren't in your list were found on this device. You can restore them as accounts.";

export default function FoundAccountsNotice({
  count,
  address,
  onReview,
  onDismiss,
}: FoundAccountsNoticeProps) {
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const title = `${count} account${count === 1 ? '' : 's'} found on this device`;

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
            {address ? (
              <Text style={styles.address}>{formatAddress(address)}</Text>
            ) : null}
          </View>
          <TouchableOpacity
            testID="found-accounts-dismiss"
            onPress={onDismiss}
            style={styles.dismissButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss notice"
          >
            <Ionicons name="close" size={20} color={styles.dismissIcon.color} />
          </TouchableOpacity>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={onReview}
            style={styles.reviewButton}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Review</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onDismiss}
            style={styles.laterButton}
            accessibilityRole="button"
          >
            <Text style={styles.laterText}>Not now</Text>
          </TouchableOpacity>
        </View>
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
    address: {
      color: theme.colors.textMuted,
      fontSize: 13,
      marginTop: 4,
    },
    dismissButton: { padding: 4, marginLeft: 8 },
    dismissIcon: { color: theme.colors.textMuted },
    actions: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
    reviewButton: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 18,
      backgroundColor: theme.colors.primary,
    },
    buttonText: { color: '#FFFFFF', fontWeight: '600' },
    laterButton: { paddingVertical: 8, paddingHorizontal: 14, marginLeft: 8 },
    laterText: { color: theme.colors.textSecondary, fontWeight: '600' },
  });

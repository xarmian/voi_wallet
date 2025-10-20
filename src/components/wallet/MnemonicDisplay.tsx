import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface MnemonicDisplayProps {
  mnemonic: string;
  isBlurred?: boolean;
  onToggleReveal?: () => void;
  showRevealButton?: boolean;
  showCopyButton?: boolean;
  onCopy?: () => void;
  hasCopied?: boolean;
  layout?: 'compact' | 'grid';
}

export default function MnemonicDisplay({
  mnemonic,
  isBlurred = false,
  onToggleReveal,
  showRevealButton = false,
  showCopyButton = false,
  onCopy,
  hasCopied = false,
  layout = 'compact',
}: MnemonicDisplayProps) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const mnemonicWords = mnemonic.split(' ');

  return (
    <View style={styles.container}>
      {showRevealButton && (
        <View style={styles.header}>
          <Text style={styles.title}>Your 25-Word Recovery Phrase</Text>
          <TouchableOpacity
            style={styles.revealButton}
            onPress={onToggleReveal}
          >
            <Ionicons
              name={isBlurred ? 'eye-off' : 'eye'}
              size={20}
              color={theme.colors.primary}
            />
            <Text style={styles.revealButtonText}>
              {isBlurred ? 'Reveal' : 'Hide'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.mnemonicContainer}>
        <View
          style={[
            layout === 'grid'
              ? styles.mnemonicGridLayout
              : styles.mnemonicCompactLayout,
            isBlurred && styles.blurred,
          ]}
        >
          {mnemonicWords.map((word, index) => (
            <View
              key={index}
              style={[
                styles.wordContainer,
                layout === 'grid'
                  ? styles.wordContainerGrid
                  : styles.wordContainerCompact,
              ]}
            >
              <Text
                style={[
                  styles.wordNumber,
                  layout === 'grid'
                    ? styles.wordNumberGrid
                    : styles.wordNumberCompact,
                ]}
              >
                {index + 1}
              </Text>
              <Text
                style={[
                  styles.word,
                  layout === 'grid' ? styles.wordGrid : styles.wordCompact,
                ]}
              >
                {word}
              </Text>
            </View>
          ))}
        </View>

        {isBlurred && (
          <View style={styles.blurOverlay}>
            <Ionicons name="eye-off" size={48} color={theme.colors.textMuted} />
            <Text style={styles.blurText}>
              {showRevealButton
                ? 'Tap "Reveal" to show your recovery phrase'
                : 'Recovery phrase hidden for security'}
            </Text>
          </View>
        )}
      </View>

      {showCopyButton && !isBlurred && (
        <TouchableOpacity
          style={[styles.copyButton, hasCopied && styles.copiedButton]}
          onPress={onCopy}
        >
          <Ionicons
            name={hasCopied ? 'checkmark' : 'copy'}
            size={20}
            color="white"
          />
          <Text style={styles.copyButtonText}>
            {hasCopied ? 'Copied!' : 'Copy to Clipboard'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      width: '100%',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
      paddingHorizontal: theme.spacing.xs,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    revealButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(10, 132, 255, 0.1)' : '#F0F9FF',
      borderRadius: theme.borderRadius.md,
    },
    revealButtonText: {
      marginLeft: 6,
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '500',
    },
    mnemonicContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      position: 'relative',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    mnemonicCompactLayout: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
    },
    mnemonicGridLayout: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
    },
    blurred: {
      opacity: 0.3,
    },
    wordContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
      marginBottom: theme.spacing.sm,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    wordContainerCompact: {
      width: '48%',
      flexDirection: 'row',
      alignItems: 'center',
      padding: theme.spacing.sm,
    },
    wordContainerGrid: {
      width: '23%',
      padding: theme.spacing.sm,
      alignItems: 'center',
    },
    wordNumber: {
      color: theme.colors.textMuted,
      fontWeight: '500',
    },
    wordNumberCompact: {
      fontSize: 12,
      marginRight: theme.spacing.sm,
      minWidth: 20,
    },
    wordNumberGrid: {
      fontSize: 10,
      marginBottom: 2,
    },
    word: {
      color: theme.colors.text,
      fontWeight: '600',
    },
    wordCompact: {
      fontSize: 16,
    },
    wordGrid: {
      fontSize: 12,
      textAlign: 'center',
      fontFamily: 'monospace',
    },
    blurOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(44, 44, 46, 0.95)'
          : 'rgba(255, 255, 255, 0.9)',
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: theme.borderRadius.xl,
    },
    blurText: {
      marginTop: theme.spacing.sm,
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    copyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginTop: theme.spacing.md,
    },
    copiedButton: {
      backgroundColor: theme.colors.success,
    },
    copyButtonText: {
      marginLeft: theme.spacing.sm,
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });

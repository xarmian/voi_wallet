import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { MAX_MESSAGE_LENGTH, MESSAGE_FEE_DISPLAY } from '@/services/messaging/types';
import { BlurredContainer } from '@/components/common/BlurredContainer';

// Common emojis organized by category
const EMOJI_CATEGORIES = [
  {
    name: 'Smileys',
    emojis: ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😋', '😜', '🤪', '😎', '🤩', '🥳', '😏', '😒', '🙄', '😬', '😮', '😯', '😲', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯', '😱', '🤗', '🤔', '🤫', '🤭'],
  },
  {
    name: 'Gestures',
    emojis: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏', '🙌', '🤲', '🤝', '🙏', '💪', '🦾', '🖕'],
  },
  {
    name: 'Hearts',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟'],
  },
  {
    name: 'Objects',
    emojis: ['🎉', '🎊', '🎁', '🎈', '✨', '🌟', '⭐', '💫', '🔥', '💯', '💰', '💎', '🏆', '🎯', '🚀', '💡', '📱', '💻', '🎮', '🎵', '🎶', '📸', '🎬', '📚', '✈️', '🌍'],
  },
  {
    name: 'Food',
    emojis: ['🍕', '🍔', '🍟', '🌭', '🍿', '🧀', '🥚', '🍳', '🥓', '🥐', '🍞', '🥖', '🥨', '🥯', '🥞', '🧇', '🧁', '🍰', '🎂', '🍩', '🍪', '🍫', '🍬', '☕', '🍺', '🍷'],
  },
  {
    name: 'Animals',
    emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦄', '🐝', '🦋', '🐌', '🐙', '🦀', '🐠'],
  },
];

const RECENT_EMOJIS_KEY = '@recent_emojis';

interface MessageInputProps {
  onSend: (content: string) => Promise<void>;
  isSending: boolean;
  disabled?: boolean;
  onInfoPress?: () => void;
  placeholder?: string;
}

export default function MessageInput({
  onSend,
  isSending,
  disabled = false,
  onInfoPress,
  placeholder,
}: MessageInputProps) {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const [message, setMessage] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(0);
  const inputRef = useRef<TextInput>(null);

  const canSend = message.trim().length > 0 && !isSending && !disabled;
  const isOverLimit = message.length > MAX_MESSAGE_LENGTH;
  const showCharCounter = message.length > MAX_MESSAGE_LENGTH - 100;

  const handleSend = useCallback(async () => {
    if (!canSend || isOverLimit) return;

    const content = message.trim();
    setMessage('');
    setShowEmojiPicker(false);
    await onSend(content);
  }, [message, canSend, isOverLimit, onSend]);

  const handleEmojiPress = useCallback((emoji: string) => {
    setMessage((prev) => prev + emoji);
  }, []);

  const toggleEmojiPicker = useCallback(() => {
    if (showEmojiPicker) {
      setShowEmojiPicker(false);
      inputRef.current?.focus();
    } else {
      Keyboard.dismiss();
      setShowEmojiPicker(true);
    }
  }, [showEmojiPicker]);

  const handleInputFocus = useCallback(() => {
    setShowEmojiPicker(false);
  }, []);

  return (
    <BlurredContainer style={styles.container} borderRadius={0}>
      {/* Fee notice */}
      <View style={styles.feeNotice}>
        <Text style={styles.feeText}>Each message costs {MESSAGE_FEE_DISPLAY}</Text>
        <TouchableOpacity onPress={onInfoPress} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons
            name="information-circle-outline"
            size={16}
            color={theme.colors.textMuted}
          />
        </TouchableOpacity>
      </View>

      {/* Input row */}
      <View style={styles.inputRow}>
        {/* Emoji button */}
        <TouchableOpacity
          style={styles.emojiButton}
          onPress={toggleEmojiPicker}
          activeOpacity={0.7}
        >
          <Ionicons
            name={showEmojiPicker ? 'keypad' : 'happy-outline'}
            size={24}
            color={showEmojiPicker ? theme.colors.primary : theme.colors.textMuted}
          />
        </TouchableOpacity>

        <View style={[styles.inputContainer, isOverLimit && styles.inputContainerError]}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder={placeholder || "Type a message..."}
            placeholderTextColor={theme.colors.textMuted}
            value={message}
            onChangeText={setMessage}
            onFocus={handleInputFocus}
            multiline
            maxLength={MAX_MESSAGE_LENGTH + 50} // Allow slight overage to show error
            editable={!disabled}
          />
          {showCharCounter && (
            <Text
              style={[
                styles.charCounter,
                isOverLimit && { color: theme.colors.error || '#EF4444' },
              ]}
            >
              {message.length}/{MAX_MESSAGE_LENGTH}
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={[
            styles.sendButton,
            { backgroundColor: canSend && !isOverLimit ? theme.colors.primary : theme.colors.surface },
          ]}
          onPress={handleSend}
          disabled={!canSend || isOverLimit}
          activeOpacity={0.7}
        >
          {isSending ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Ionicons
              name="send"
              size={20}
              color={canSend && !isOverLimit ? 'white' : theme.colors.textMuted}
            />
          )}
        </TouchableOpacity>
      </View>

      {/* Emoji Picker */}
      {showEmojiPicker && (
        <View style={[styles.emojiPicker, { backgroundColor: theme.colors.surface }]}>
          {/* Category tabs */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.categoryTabs}
            contentContainerStyle={styles.categoryTabsContent}
          >
            {EMOJI_CATEGORIES.map((category, index) => (
              <TouchableOpacity
                key={category.name}
                style={[
                  styles.categoryTab,
                  selectedCategory === index && {
                    backgroundColor: theme.colors.primary + '20',
                    borderColor: theme.colors.primary,
                  },
                ]}
                onPress={() => setSelectedCategory(index)}
              >
                <Text style={[
                  styles.categoryTabText,
                  { color: selectedCategory === index ? theme.colors.primary : theme.colors.textMuted }
                ]}>
                  {category.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Emoji grid */}
          <ScrollView
            style={styles.emojiGrid}
            contentContainerStyle={styles.emojiGridContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.emojiRow}>
              {EMOJI_CATEGORIES[selectedCategory].emojis.map((emoji, index) => (
                <TouchableOpacity
                  key={`${emoji}-${index}`}
                  style={styles.emojiItem}
                  onPress={() => handleEmojiPress(emoji)}
                  activeOpacity={0.6}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        </View>
      )}
    </BlurredContainer>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    feeNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingBottom: theme.spacing.xs,
    },
    feeText: {
      fontSize: 11,
      color: theme.colors.textMuted,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: theme.spacing.xs,
    },
    emojiButton: {
      width: 36,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 0,
    },
    inputContainer: {
      flex: 1,
      backgroundColor: theme.colors.surface + '80',
      borderRadius: 20,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
      minHeight: 40,
      maxHeight: 120,
      borderWidth: 1,
      borderColor: 'transparent',
      justifyContent: 'center',
    },
    inputContainerError: {
      borderColor: theme.colors.error || '#EF4444',
    },
    input: {
      fontSize: 15,
      color: theme.colors.text,
      maxHeight: 100,
      paddingTop: 0,
      paddingBottom: 0,
      textAlignVertical: 'center',
    },
    charCounter: {
      fontSize: 10,
      color: theme.colors.textMuted,
      textAlign: 'right',
      marginTop: 2,
    },
    sendButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 0,
    },
    // Emoji picker styles
    emojiPicker: {
      marginTop: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      overflow: 'hidden',
    },
    categoryTabs: {
      maxHeight: 36,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    categoryTabsContent: {
      paddingHorizontal: theme.spacing.xs,
      gap: theme.spacing.xs,
    },
    categoryTab: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    categoryTabText: {
      fontSize: 12,
      fontWeight: '500',
    },
    emojiGrid: {
      maxHeight: 180,
    },
    emojiGridContent: {
      padding: theme.spacing.sm,
    },
    emojiRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
    },
    emojiItem: {
      width: '12.5%', // 8 emojis per row
      aspectRatio: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emoji: {
      fontSize: 24,
    },
  });

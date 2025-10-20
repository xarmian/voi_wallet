import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  FlatList,
  Keyboard,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import {
  CommonActions,
  RouteProp,
  useFocusEffect,
} from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { useWalletStore } from '@/store/walletStore';
import { BIP39Utils, WordSuggestion } from '@/utils/bip39';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemeColors } from '@/hooks/useThemedStyles';

type MnemonicImportScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'MnemonicImport'
>;

type MnemonicImportScreenRouteProp = RouteProp<
  RootStackParamList,
  'MnemonicImport'
>;

interface Props {
  navigation: MnemonicImportScreenNavigationProp;
  route: MnemonicImportScreenRouteProp;
}

export default function MnemonicImportScreen({ navigation, route }: Props) {
  const [words, setWords] = useState<string[]>(Array(25).fill(''));
  const [suggestions, setSuggestions] = useState<WordSuggestion[]>([]);
  const [currentWordIndex, setCurrentWordIndex] = useState<number>(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [accountLabel, setAccountLabel] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const insets = useSafeAreaInsets();

  const importAccount = useWalletStore((state) => state.importAccount);

  const inputRefs = useRef<(TextInput | null)[]>(Array(25).fill(null));
  const scrollViewRef = useRef<any>(null);

  useFocusEffect(
    useCallback(() => {
      if (route.params?.isOnboarding) {
        return undefined;
      }

      const state = navigation.getState() as
        | {
            type?: string;
            routes?: Array<{ name: string; params?: unknown }>;
          }
        | undefined;

      if (
        state?.type === 'stack' &&
        state.routes?.length === 1 &&
        state.routes[0]?.name === 'MnemonicImport'
      ) {
        const currentParams = state.routes[0]?.params;

        navigation.reset({
          index: 1,
          routes: [
            { name: 'SettingsMain' as never },
            { name: 'MnemonicImport' as never, params: currentParams },
          ],
        });
      }

      return undefined;
    }, [navigation, route.params?.isOnboarding])
  );

  const validateWord = useCallback((word: string): boolean => {
    if (!word.trim()) return true; // Empty is valid (not yet filled)
    return BIP39Utils.isValidWord(word);
  }, []);

  const getWordValidationState = useCallback(
    (word: string, index: number): 'valid' | 'invalid' | 'empty' => {
      if (!word.trim()) return 'empty';
      return validateWord(word) ? 'valid' : 'invalid';
    },
    [validateWord]
  );

  const updateWordSuggestions = useCallback(
    (word: string, wordIndex: number) => {
      if (!word.trim()) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }

      const wordSuggestions = BIP39Utils.getWordSuggestions(word, 5);
      setSuggestions(wordSuggestions);
      setCurrentWordIndex(wordIndex);
      setShowSuggestions(wordSuggestions.length > 0);
    },
    []
  );

  const clearImportState = useCallback(() => {
    setWords(Array(25).fill(''));
    setSuggestions([]);
    setShowSuggestions(false);
    setCurrentWordIndex(-1);
  }, []);

  const handleWordChange = useCallback(
    (text: string, index: number) => {
      // Detect if this is a multi-word paste operation
      const trimmedText = text.trim();
      const pastedWords = trimmedText.split(/\s+/).filter(w => w.length > 0);

      if (pastedWords.length > 1) {
        // Multi-word paste: insert starting from current position
        const newWords = [...words];

        // Insert pasted words starting at current index
        pastedWords.forEach((word, offset) => {
          const targetIndex = index + offset;
          if (targetIndex < 25) {
            newWords[targetIndex] = word.toLowerCase();
          }
        });

        setWords(newWords);
        setSuggestions([]);
        setShowSuggestions(false);

        // Focus on the next empty field after pasted content
        const lastPastedIndex = Math.min(index + pastedWords.length, 24);
        const nextEmptyIndex = newWords.findIndex(
          (word, idx) => idx > lastPastedIndex && !word.trim()
        );

        const focusIndex = nextEmptyIndex >= 0 ? nextEmptyIndex : lastPastedIndex;
        setTimeout(() => {
          inputRefs.current[focusIndex]?.focus();
        }, 100);

        return;
      }

      // Single word input: normal behavior
      const newWords = [...words];
      newWords[index] = text.toLowerCase();
      setWords(newWords);

      // Update suggestions with raw text (not trimmed during typing)
      updateWordSuggestions(text, index);

      // Auto-advance only if the word is a complete, unambiguous BIP39 word
      const cleanWord = text.trim().toLowerCase();
      if (cleanWord.length > 0 && BIP39Utils.isValidWord(cleanWord)) {
        const candidates = BIP39Utils.getWordSuggestions(cleanWord, 2);
        const hasLongerOption = candidates.some((s) => s.word !== cleanWord);
        if (!hasLongerOption) {
          const nextIndex = index + 1;
          if (nextIndex < 25) {
            setTimeout(() => {
              inputRefs.current[nextIndex]?.focus();
            }, 100);
          }
        }
      }
    },
    [words, updateWordSuggestions]
  );

  const handleSuggestionPress = useCallback(
    (suggestion: WordSuggestion) => {
      if (currentWordIndex < 0 || currentWordIndex >= 25) {
        return;
      }

      const newWords = [...words];
      newWords[currentWordIndex] = suggestion.word;
      setWords(newWords);

      setSuggestions([]);
      setShowSuggestions(false);

      const nextIndex = currentWordIndex + 1;
      const targetIndex = nextIndex < 25 ? nextIndex : currentWordIndex;

      setTimeout(() => {
        inputRefs.current[targetIndex]?.focus();
      }, 0);
    },
    [currentWordIndex, words]
  );

  const handleWordFocus = useCallback(
    (index: number) => {
      setCurrentWordIndex(index);
      const word = words[index];
      if (word) {
        updateWordSuggestions(word, index);
      }
    },
    [words, updateWordSuggestions]
  );

  const handleWordBlur = useCallback(() => {
    setTimeout(() => {
      setShowSuggestions(false);
      setCurrentWordIndex(-1);
    }, 200);
  }, []);

  const isValidMnemonic = useCallback((): boolean => {
    return BIP39Utils.validateMnemonicWords(words);
  }, [words]);

  const handleImport = useCallback(async () => {
    if (!isValidMnemonic()) {
      Alert.alert(
        'Invalid Mnemonic',
        'Please ensure all 25 words are valid BIP39 words.'
      );
      return;
    }

    setIsImporting(true);

    try {
      const mnemonic = BIP39Utils.getMnemonicFromWords(words);
      const isOnboarding = route.params?.isOnboarding;
      const normalizedLabel = accountLabel.trim();

      if (isOnboarding) {
        // For onboarding, navigate to SecuritySetup with mnemonic
        navigation.navigate('SecuritySetup', {
          mnemonic,
          source: 'mnemonic',
          accountLabel: normalizedLabel || undefined,
        });
      } else {
        // For adding additional accounts, import directly
        await importAccount({
          mnemonic,
          label:
            normalizedLabel ||
            `Imported Account ${new Date().toLocaleDateString()}`,
        });

        Keyboard.dismiss();
        clearImportState();
        setAccountLabel('');

        const parentNavigation = navigation.getParent();
        const canGoBack = navigation.canGoBack();

        if (canGoBack) {
          navigation.goBack();
        }

        parentNavigation?.dispatch(
          CommonActions.navigate({
            name: 'Settings',
            params: { screen: 'SettingsMain' },
          })
        );

        Alert.alert('Success', 'Account imported successfully!');
      }
    } catch (error) {
      console.error('Import error:', error);
      Alert.alert(
        'Import Failed',
        error instanceof Error
          ? error.message
          : 'Failed to import account. Please try again.'
      );
    } finally {
      setIsImporting(false);
    }
  }, [
    isValidMnemonic,
    words,
    navigation,
    route.params?.isOnboarding,
    clearImportState,
    importAccount,
    accountLabel,
  ]);

  const handleClear = useCallback(() => {
    Alert.alert(
      'Clear All Words',
      'Are you sure you want to clear all entered words?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            clearImportState();
            inputRefs.current[0]?.focus();
          },
        },
      ]
    );
  }, [clearImportState]);

  const renderWordInput = useCallback(
    ({ item: index }: { item: number }) => {
      const word = words[index];
      const validationState = getWordValidationState(word, index);

      return (
        <View
          style={[
            styles.wordInputContainer,
            {
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
            },
            validationState === 'invalid' && {
              backgroundColor: theme.colors.errorLight,
              borderColor: theme.colors.error,
              borderWidth: 2,
            },
            validationState === 'valid' && {
              borderColor: theme.colors.success,
              borderWidth: 1.5,
            },
          ]}
        >
          <Text
            style={[
              styles.wordNumber,
              {
                color:
                  validationState === 'invalid'
                    ? theme.colors.error
                    : theme.colors.textSecondary,
              },
            ]}
          >
            {index + 1}
          </Text>
          <TextInput
            ref={(ref) => (inputRefs.current[index] = ref)}
            style={[
              styles.wordInput,
              {
                color:
                  validationState === 'invalid'
                    ? theme.colors.error
                    : theme.colors.text,
              },
            ]}
            value={word}
            onChangeText={(text) => handleWordChange(text, index)}
            onFocus={() => handleWordFocus(index)}
            onBlur={handleWordBlur}
            placeholder={`Word ${index + 1}`}
            placeholderTextColor={themeColors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType={index === 24 ? 'done' : 'next'}
            onSubmitEditing={() => {
              if (index < 24) {
                inputRefs.current[index + 1]?.focus();
              } else {
                Keyboard.dismiss();
              }
            }}
          />
          {validationState === 'invalid' && (
            <Ionicons
              name="close-circle"
              size={20}
              color={theme.colors.error}
            />
          )}
          {validationState === 'valid' && (
            <Ionicons
              name="checkmark-circle"
              size={18}
              color={theme.colors.success}
            />
          )}
        </View>
      );
    },
    [
      words,
      getWordValidationState,
      handleWordChange,
      handleWordFocus,
      handleWordBlur,
    ]
  );

  const renderSuggestion = useCallback(
    ({ item }: { item: WordSuggestion }) => {
      const currentWord = words[currentWordIndex]?.toLowerCase().trim() || '';
      const matchLength = currentWord.length;

      return (
        <TouchableOpacity
          style={[
            styles.suggestionItem,
            {
              backgroundColor: theme.colors.background,
              borderColor: theme.colors.border,
            },
          ]}
          onPress={() => handleSuggestionPress(item)}
          activeOpacity={0.7}
        >
          <Text style={[styles.suggestionText, { color: theme.colors.text }]}>
            <Text style={styles.suggestionMatch}>{item.word.substring(0, matchLength)}</Text>
            {item.word.substring(matchLength)}
          </Text>
        </TouchableOpacity>
      );
    },
    [handleSuggestionPress, words, currentWordIndex, theme]
  );

  useEffect(() => {
    // Focus on first input when component mounts
    setTimeout(() => {
      inputRefs.current[0]?.focus();
    }, 500);
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = (e: any) => {
      const height = e?.endCoordinates?.height ?? 0;
      setKeyboardHeight(height);
    };
    const onHide = () => setKeyboardHeight(0);

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      return () => {
        clearImportState();
      };
    }, [clearImportState])
  );

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.content}>
          {/* Header */}
          <View
            style={[
              styles.header,
              {
                backgroundColor: theme.colors.card,
                borderBottomColor: theme.colors.border,
              },
            ]}
          >
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => navigation.goBack()}
            >
              <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
            </TouchableOpacity>
            <Text style={[styles.title, { color: theme.colors.text }]}>
              Import Account
            </Text>
            <TouchableOpacity
              style={[
                styles.headerImportButton,
                {
                  backgroundColor:
                    !isValidMnemonic() || isImporting
                      ? theme.colors.disabled
                      : theme.colors.primary,
                },
              ]}
              onPress={handleImport}
              disabled={!isValidMnemonic() || isImporting}
            >
              <Text
                style={[
                  styles.headerImportButtonText,
                  {
                    color:
                      !isValidMnemonic() || isImporting
                        ? theme.colors.textSecondary
                        : theme.colors.background,
                  },
                ]}
              >
                {isImporting ? 'Importing...' : 'Import'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Instructions */}
          <View
            style={[
              styles.instructionsContainer,
              {
                backgroundColor: theme.colors.card,
                borderBottomColor: theme.colors.border,
              },
            ]}
          >
            <Text style={[styles.subtitle, { color: theme.colors.text }]}>
              Enter your 25-word recovery phrase
            </Text>
            <Text
              style={[
                styles.instructions,
                { color: theme.colors.textSecondary },
              ]}
            >
              Type each word or paste your entire recovery phrase. Word
              suggestions will appear above your keyboard.
            </Text>
          </View>

          {/* Word Input Grid */}
          <KeyboardAwareScrollView
            ref={scrollViewRef}
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            extraScrollHeight={0}
            showsVerticalScrollIndicator={false}
          >
            <FlatList
              data={Array.from({ length: 25 }, (_, i) => i)}
              renderItem={renderWordInput}
              numColumns={2}
              scrollEnabled={false}
              keyExtractor={(item) => item.toString()}
              columnWrapperStyle={styles.row}
              contentContainerStyle={styles.wordsGrid}
            />

            <View style={styles.accountNameContainer}>
              <Text
                style={[
                  styles.accountNameLabel,
                  { color: theme.colors.textSecondary },
                ]}
              >
                Account Name (optional)
              </Text>
              <TextInput
                style={[
                  styles.accountNameInput,
                  { color: theme.colors.text },
                ]}
                value={accountLabel}
                onChangeText={setAccountLabel}
                placeholder="Imported account name"
                placeholderTextColor={themeColors.placeholder}
                autoCapitalize="words"
                autoComplete="name"
                autoCorrect={false}
                returnKeyType="done"
              />
            </View>

            <View style={styles.importButtonContainer}>
              <TouchableOpacity
                style={[
                  styles.importButton,
                  {
                    backgroundColor:
                      !isValidMnemonic() || isImporting
                        ? theme.colors.disabled
                        : theme.colors.primary,
                  },
                ]}
                onPress={handleImport}
                disabled={!isValidMnemonic() || isImporting}
                activeOpacity={0.8}
              >
                <Text
                  style={[
                    styles.importButtonText,
                    {
                      color:
                        !isValidMnemonic() || isImporting
                          ? theme.colors.textSecondary
                          : theme.colors.background,
                    },
                  ]}
                >
                  {isImporting ? 'Importing...' : 'Import Account'}
                </Text>
              </TouchableOpacity>
            </View>
          </KeyboardAwareScrollView>

          {/* Suggestions */}
          {showSuggestions && suggestions.length > 0 && (
            <View
              style={[
                styles.suggestionsContainer,
                {
                  backgroundColor: theme.colors.card,
                  borderTopColor: theme.colors.border,
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: Math.max(keyboardHeight - insets.bottom, 0),
                  zIndex: 1000,
                  elevation: 10,
                },
              ]}
              pointerEvents="box-none"
            >
              <FlatList
                data={suggestions}
                renderItem={renderSuggestion}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(item) => item.word}
                contentContainerStyle={styles.suggestionsList}
                keyboardShouldPersistTaps="handled"
              />
            </View>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 4,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
  headerImportButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  headerImportButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  instructionsContainer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  instructions: {
    fontSize: 14,
    lineHeight: 20,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32,
  },
  wordsGrid: {
    padding: 20,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  wordInputContainer: {
    width: '48%',
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 14,
    marginHorizontal: 4,
    minHeight: 56,
  },
  wordNumber: {
    fontSize: 12,
    fontWeight: '500',
    marginRight: 8,
    minWidth: 20,
  },
  wordInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: Platform.select({ ios: 10, default: 8 }),
  },
  suggestionsContainer: {
    borderTopWidth: 1,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: -2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 5,
    marginBottom: Platform.OS === 'android' ? -26 : -50,
  },
  suggestionsList: {
    paddingHorizontal: 12,
    gap: 8,
  },
  suggestionItem: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginRight: 8,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  suggestionText: {
    fontSize: 15,
    fontWeight: '500',
  },
  suggestionMatch: {
    textDecorationLine: 'underline',
    fontWeight: '700',
  },
  accountNameContainer: {
    marginTop: 12,
    paddingHorizontal: 20,
    gap: 6,
  },
  accountNameLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  accountNameInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.select({ ios: 12, default: 10 }),
    fontSize: 16,
  },
  importButtonContainer: {
    marginTop: 16,
    paddingHorizontal: 20,
  },
  importButton: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  importButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

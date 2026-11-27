import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
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
  type LayoutChangeEvent,
  type StyleProp,
  type TextInputInstance,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  CommonActions,
  RouteProp,
  useFocusEffect,
} from '@react-navigation/native';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { AccountType, backupVerifiedAtImport } from '@/types/wallet';
import { useWalletStore } from '@/store/walletStore';
import { BIP39Utils, WordSuggestion } from '@/utils/bip39';
import { storeMnemonicSecret } from '@/utils/accountQRParser';
import { AccountSecureStorage } from '@/services/secure';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemeColors } from '@/hooks/useThemedStyles';
import { useSecureScreen } from '@/hooks/useSecureScreen';
import { computeRevealOffset } from '@/utils/scrollReveal';

type MnemonicImportScreenNavigationProp = NativeStackNavigationProp<
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

/**
 * TASK-556: true only when `next` is `previous` with exactly one character
 * inserted somewhere (one keystroke). A multi-character insertion or a deletion
 * returns false, and so does a replaced selection unless its result is exactly
 * what one keystroke could have produced; a change that also leaves the field
 * holding several words then counts as a paste (fails closed). A field's state
 * holds at most one word, so one keystroke can add at most one letter or one
 * split: it can never carry a pasted word.
 */
function isSingleCharInsertion(previous: string, next: string): boolean {
  const prev = previous.toLowerCase();
  const nxt = next.toLowerCase();
  if (nxt.length !== prev.length + 1) return false;
  let i = 0;
  while (i < prev.length && prev[i] === nxt[i]) i++;
  return nxt.slice(i + 1) === prev.slice(i);
}

/*
 * TASK-554: this screen reveals the focused field itself instead of using the
 * keyboard-aware library's automatic scroll. That scroll is wrong here on both
 * platforms. iOS: React Native's scroll-to-keyboard math assumes the scroll
 * view starts at the top of the window, so with the header above it the field
 * lands under the keyboard, and it fires again on every focus change (iOS
 * re-sends keyboardWillShow), even after a manual scroll. Android: the library
 * assumes the system already panned the window and scrolls only its extra
 * height, but the app is edge-to-edge (the window no longer resizes for the
 * keyboard) and keyboardDidShow fires only when the keyboard opens, so the
 * grid never follows the focus. Neither accounts for the suggestions bar.
 */
/** Gap kept between a revealed field and the covered band (or the top). */
const REVEAL_MARGIN = 12;
/** Suggestions bar height before its first layout (8 + chip + 8 + border). */
const SUGGESTION_BAR_FALLBACK_HEIGHT = 56;
/** Reveal target id of the account-name field (word fields are 0-24). */
const ACCOUNT_NAME_TARGET = 25;

/** A laid-out box: top edge in its parent's coordinates, and height. */
type Box = { y: number; height: number };

/** Receives each word-grid row's layout from WordGridRow (row = index / 2). */
const WordRowLayoutContext = createContext<
  ((row: number, box: Box) => void) | null
>(null);

type WordGridRowProps = {
  index: number;
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
  onFocusCapture?: ViewProps['onFocusCapture'];
  children?: React.ReactNode;
};

/**
 * The word grid's FlatList cell (one row of two fields). Reports the row's y
 * within the grid so a field's position in the scroll content is known from
 * layout alone, and forwards the list's own onLayout.
 */
function WordGridRow({
  index,
  style,
  onLayout,
  onFocusCapture,
  children,
}: WordGridRowProps) {
  const recordRowLayout = useContext(WordRowLayoutContext);
  return (
    <View
      style={style}
      onFocusCapture={onFocusCapture}
      testID={`mnemonic-word-row-${index}`}
      onLayout={(event) => {
        const { y, height } = event.nativeEvent.layout;
        recordRowLayout?.(index, { y, height });
        onLayout?.(event);
      }}
    >
      {children}
    </View>
  );
}

export default function MnemonicImportScreen({ navigation, route }: Props) {
  const [words, setWords] = useState<string[]>(Array(25).fill(''));
  const [suggestions, setSuggestions] = useState<WordSuggestion[]>([]);
  const [currentWordIndex, setCurrentWordIndex] = useState<number>(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [accountLabel, setAccountLabel] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [suggestionBarHeight, setSuggestionBarHeight] = useState(
    SUGGESTION_BAR_FALLBACK_HEIGHT
  );
  const { theme } = useTheme();

  // Block OS screenshots / screen recordings: each entered recovery-phrase word
  // is rendered in clear text here. No-op on web/extension.
  useSecureScreen();
  const themeColors = useThemeColors();
  const insets = useSafeAreaInsets();
  // Undefined outside a bottom-tab navigator (onboarding); 0 there.
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;

  const importAccount = useWalletStore((state) => state.importAccount);

  const inputRefs = useRef<(TextInputInstance | null)[]>(Array(25).fill(null));
  const scrollViewRef = useRef<any>(null);
  // TASK-556: set once a change inserts more than one character at once and
  // leaves the field holding several words: a clipboard paste, or keyboard /
  // password-manager autofill, which arrives the same way. A pasted phrase may
  // only ever have lived in the clipboard, so the entry imports as NOT backed
  // up. Later edits never clear it; it stays set until clearImportState runs
  // (leaving the screen, or a successful add-account import). A single
  // keystroke is typing even when it makes the field hold two words (a typed
  // space, then the next word's first letter), and a suggestion-chip tap
  // inserts one word and counts as typing. Known limit: any paste that arrives
  // as a single token with no whitespace (one word per field, or a phrase
  // joined by commas that typed spaces then split) is indistinguishable from
  // a keyboard suggestion and counts as typed.
  const phrasePastedRef = useRef(false);

  // TASK-554: what the reveal needs, all from layout and scroll events (no
  // native measuring). Written by event handlers, read only in handlers and
  // effects.
  const scrollYRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const gridYRef = useRef(0);
  const rowBoxesRef = useRef<(Box | undefined)[]>([]);
  const wordBoxesRef = useRef<(Box | undefined)[]>([]);
  const accountNameBoxRef = useRef<Box | null>(null);
  const suggestionBarHeightRef = useRef(SUGGESTION_BAR_FALLBACK_HEIGHT);
  const keyboardHeightRef = useRef(0);
  // The focused word index (0-24), ACCOUNT_NAME_TARGET, or -1.
  const focusedTargetRef = useRef(-1);

  /**
   * How much of the scroll view's bottom the keyboard covers, for a keyboard
   * height as reported by the keyboard events: the distance from the scroll
   * view's bottom (also the bottom of the View holding the suggestions bar)
   * up to the keyboard's top edge. The suggestions bar sits at this offset,
   * and the reveal keeps this band plus the bar clear. The scroll view
   * reaches the screen's bottom edge, or the tab bar's top in a tab.
   * Android reports the height without the navigation-bar inset (React Native
   * subtracts the system bars), while the edge-to-edge window still extends
   * under that bar, so it is added back there; iOS reports the full height.
   */
  const keyboardBand = useCallback(
    (height: number) =>
      height > 0
        ? Math.max(
            0,
            height +
              (Platform.OS === 'android' ? insets.bottom : 0) -
              tabBarHeight
          )
        : 0,
    [insets.bottom, tabBarHeight]
  );

  /**
   * Scrolls the minimal amount needed to show `target` fully above the
   * keyboard (and above the suggestions bar, for a word field), and not at all
   * when it is already fully visible. Only focus and keyboard show / resize
   * call this, so other re-renders and layout passes never scroll.
   */
  const revealTarget = useCallback(
    (target: number) => {
      const keyboard = keyboardHeightRef.current;
      const viewportHeight = viewportHeightRef.current;
      // No keyboard yet: nothing covers the field; the show event reveals it.
      if (keyboard <= 0 || viewportHeight <= 0) return;

      let box: Box | null = null;
      let obscuredBottom = keyboardBand(keyboard);
      if (target === ACCOUNT_NAME_TARGET) {
        box = accountNameBoxRef.current;
      } else if (target >= 0 && target < 25) {
        const row = rowBoxesRef.current[Math.floor(target / 2)];
        const cell = wordBoxesRef.current[target];
        if (row) {
          box = {
            y: gridYRef.current + row.y + (cell?.y ?? 0),
            height: cell?.height ?? row.height,
          };
        }
        // Suggestions can show for any focused word field: always keep the
        // bar's band clear, so it never covers the field as the user types.
        obscuredBottom += suggestionBarHeightRef.current;
      }
      if (!box) return;

      const offset = computeRevealOffset({
        fieldTop: box.y,
        fieldHeight: box.height,
        scrollY: scrollYRef.current,
        viewportHeight,
        obscuredBottom,
        margin: REVEAL_MARGIN,
      });
      if (offset === null) return;
      // Record the target now so a second trigger before the scroll events
      // arrive (focus and keyboard event together) sees the field revealed.
      scrollYRef.current = offset;
      scrollViewRef.current?.scrollToPosition(0, offset, true);
    },
    [keyboardBand]
  );

  const recordRowLayout = useCallback((row: number, box: Box) => {
    rowBoxesRef.current[row] = box;
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (route.params?.isOnboarding) {
        return undefined;
      }

      const state = navigation.getState() as
        | {
            type?: string;
            routes?: { name: string; params?: unknown }[];
          }
        | undefined;

      if (
        state?.type === 'stack' &&
        state.routes?.length === 1 &&
        state.routes[0]?.name === 'MnemonicImport'
      ) {
        const currentParams = state.routes[0]?.params;

        // Cross-navigator reset (SettingsMain lives in the parent Settings
        // stack); CommonActions.reset accepts dynamic route names without casts.
        navigation.dispatch(
          CommonActions.reset({
            index: 1,
            routes: [
              { name: 'SettingsMain' },
              {
                name: 'MnemonicImport',
                params: currentParams as { isOnboarding?: boolean } | undefined,
              },
            ],
          })
        );
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
    phrasePastedRef.current = false;
    setSuggestions([]);
    setShowSuggestions(false);
    setCurrentWordIndex(-1);
  }, []);

  const handleWordChange = useCallback(
    (text: string, index: number) => {
      // Detect if this is a multi-word paste operation
      const trimmedText = text.trim();
      const pastedWords = trimmedText.split(/\s+/).filter((w) => w.length > 0);

      if (pastedWords.length > 1) {
        // Several words in one field: split them across the fields starting
        // at the current position. TASK-556: only a single typed keystroke
        // (e.g. "act " -> "act i") is typing; anything else is a paste or
        // autofill.
        const typedSplit = isSingleCharInsertion(words[index] ?? '', text);
        if (!typedSplit) {
          phrasePastedRef.current = true;
        }

        if (typedSplit) {
          // TASK-554: one keystroke split the field (a typed space then the
          // next word's first letter, or a space typed inside a word). The
          // words go in from this field on; words already in the fields after
          // it move right into the first empty field after it, so none is
          // overwritten and fields past that gap keep their place. With no
          // empty field to take them the keystroke is refused (the field keeps
          // its text), so a typed word is never dropped.
          const extra = pastedWords.length - 1;
          const emptyAfter: number[] = [];
          for (let i = index + 1; i < 25 && emptyAfter.length < extra; i++) {
            if (!words[i]?.trim()) emptyAfter.push(i);
          }
          if (emptyAfter.length < extra) {
            // Re-render with the same words so the input drops the keystroke.
            setWords([...words]);
            return;
          }
          const newWords = [...words];
          for (let k = emptyAfter.length - 1; k >= 0; k--) {
            newWords.splice(emptyAfter[k], 1);
          }
          newWords.splice(
            index,
            1,
            ...pastedWords.map((word) => word.toLowerCase())
          );
          setWords(newWords);
          setSuggestions([]);
          setShowSuggestions(false);

          // Keep typing in the field holding the partial last word, with the
          // cursor at its end.
          const focusIndex = index + extra;
          const cursor = newWords[focusIndex].length;
          setTimeout(() => {
            const input = inputRefs.current[focusIndex];
            input?.focus();
            input?.setSelection?.(cursor, cursor);
          }, 100);
          return;
        }

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
        const lastPastedIndex = Math.min(index + pastedWords.length - 1, 24);
        const nextEmptyIndex = newWords.findIndex(
          (word, idx) => idx > lastPastedIndex && !word.trim()
        );

        const focusIndex =
          nextEmptyIndex >= 0 ? nextEmptyIndex : lastPastedIndex;
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
      focusedTargetRef.current = index;
      revealTarget(index);
      setCurrentWordIndex(index);
      const word = words[index];
      if (word) {
        updateWordSuggestions(word, index);
      }
    },
    [words, updateWordSuggestions, revealTarget]
  );

  const handleWordBlur = useCallback((index: number) => {
    // Only the field losing focus clears it: the next field's focus may
    // already have arrived.
    if (focusedTargetRef.current === index) {
      focusedTargetRef.current = -1;
    }
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
        // For onboarding, hand SecuritySetup an opaque id for the phrase held
        // in the in-memory secret store (TASK-224) — never the phrase itself.
        // A fresh id per navigate: SecuritySetup clears it on unmount.
        const mnemonicSecretId = storeMnemonicSecret(mnemonic);
        navigation.navigate('SecuritySetup', {
          mnemonicSecretId,
          source: 'mnemonic',
          accountLabel: normalizedLabel || undefined,
          // TASK-556: SecuritySetup counts the phrase as backed up only on a
          // literal true (typed in; no paste or autofill detected).
          phraseTyped: !phrasePastedRef.current,
        });
      } else if (!(await AccountSecureStorage.hasPin())) {
        // TASK-522: a wallet with no PIN sets one before any key is stored.
        // The words stay on this screen, so going back loses nothing. A
        // failed read lands in the catch below: nothing routed or stored.
        navigation.navigate('SecuritySetup', {
          mnemonicSecretId: storeMnemonicSecret(mnemonic),
          source: 'mnemonic',
          addingAccount: true,
          accountLabel: normalizedLabel || undefined,
          phraseTyped: !phrasePastedRef.current,
        });
      } else {
        // For adding additional accounts, import directly. TASK-556: a phrase
        // the user typed in counts as backed up; a pasted one does not.
        await importAccount({
          type: AccountType.STANDARD,
          mnemonic,
          backupVerified: backupVerifiedAtImport(
            phrasePastedRef.current ? 'pasted' : 'entered-phrase'
          ),
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

  const renderWordInput = useCallback(
    ({ item: index }: { item: number }) => {
      const word = words[index];
      const validationState = getWordValidationState(word, index);

      return (
        <View
          testID={`mnemonic-word-cell-${index}`}
          onLayout={(event) => {
            const { y, height } = event.nativeEvent.layout;
            wordBoxesRef.current[index] = { y, height };
          }}
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
            ref={(ref) => {
              inputRefs.current[index] = ref;
            }}
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
            onBlur={() => handleWordBlur(index)}
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
      // Theme tokens the row reads: listing them re-renders the word rows on a
      // light/dark switch (previously frozen). Purely visual — no mnemonic-
      // handling logic depends on these (TASK-246).
      theme.colors.border,
      theme.colors.card,
      theme.colors.error,
      theme.colors.errorLight,
      theme.colors.success,
      theme.colors.text,
      theme.colors.textSecondary,
      themeColors.placeholder,
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
            <Text style={styles.suggestionMatch}>
              {item.word.substring(0, matchLength)}
            </Text>
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
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent =
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = (e: any) => {
      const height = e?.endCoordinates?.height ?? 0;
      keyboardHeightRef.current = height;
      setKeyboardHeight(height);
    };
    const onHide = () => {
      keyboardHeightRef.current = 0;
      setKeyboardHeight(0);
    };

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // TASK-554: the keyboard showing or changing height reveals the focused
  // field. This runs after the render that sized the keyboard spacer, so the
  // content is tall enough to scroll to. A keyboard event with an unchanged
  // height (iOS re-sends keyboardWillShow on every focus change) does not
  // re-render, so moving between fields never jumps here; focus reveals them.
  useEffect(() => {
    if (keyboardHeight > 0 && focusedTargetRef.current >= 0) {
      revealTarget(focusedTargetRef.current);
    }
  }, [keyboardHeight, revealTarget]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        clearImportState();
      };
    }, [clearImportState])
  );

  // Room below the content so the last fields can scroll clear of the
  // keyboard and the suggestions bar (the library's own keyboard inset is
  // only applied with its automatic scroll, which this screen turns off).
  const keyboardSpacerHeight =
    keyboardHeight > 0
      ? keyboardBand(keyboardHeight) + suggestionBarHeight + REVEAL_MARGIN
      : 0;

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
          {/* TASK-554: automatic scroll and its reset-on-hide scroll are off
              for this instance; revealTarget scrolls the focused field. */}
          <KeyboardAwareScrollView
            ref={scrollViewRef}
            testID="mnemonic-word-scroll"
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            extraScrollHeight={0}
            enableAutomaticScroll={false}
            enableResetScrollToCoords={false}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={(event) => {
              scrollYRef.current = event.nativeEvent.contentOffset.y;
            }}
            onLayout={(event) => {
              viewportHeightRef.current = event.nativeEvent.layout.height;
            }}
          >
            <WordRowLayoutContext.Provider value={recordRowLayout}>
              <FlatList
                testID="mnemonic-word-grid"
                data={Array.from({ length: 25 }, (_, i) => i)}
                renderItem={renderWordInput}
                numColumns={2}
                scrollEnabled={false}
                keyExtractor={(item) => item.toString()}
                columnWrapperStyle={styles.row}
                contentContainerStyle={styles.wordsGrid}
                CellRendererComponent={WordGridRow}
                onLayout={(event) => {
                  gridYRef.current = event.nativeEvent.layout.y;
                }}
              />
            </WordRowLayoutContext.Provider>

            <View
              style={styles.accountNameContainer}
              testID="mnemonic-account-name"
              onLayout={(event) => {
                const { y, height } = event.nativeEvent.layout;
                accountNameBoxRef.current = { y, height };
              }}
            >
              <Text
                style={[
                  styles.accountNameLabel,
                  { color: theme.colors.textSecondary },
                ]}
              >
                Account Name (optional)
              </Text>
              <TextInput
                style={[styles.accountNameInput, { color: theme.colors.text }]}
                value={accountLabel}
                onChangeText={setAccountLabel}
                onFocus={() => {
                  focusedTargetRef.current = ACCOUNT_NAME_TARGET;
                  revealTarget(ACCOUNT_NAME_TARGET);
                }}
                onBlur={() => {
                  if (focusedTargetRef.current === ACCOUNT_NAME_TARGET) {
                    focusedTargetRef.current = -1;
                  }
                }}
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

            <View style={{ height: keyboardSpacerHeight }} />
          </KeyboardAwareScrollView>

          {/* Suggestions */}
          {showSuggestions && suggestions.length > 0 && (
            <View
              testID="mnemonic-word-suggestions"
              onLayout={(event) => {
                const height = event.nativeEvent.layout.height;
                if (height > 0) {
                  suggestionBarHeightRef.current = height;
                  setSuggestionBarHeight(height);
                }
              }}
              style={[
                styles.suggestionsContainer,
                {
                  backgroundColor: theme.colors.card,
                  borderTopColor: theme.colors.border,
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  // On the keyboard's top edge: the same band the reveal
                  // and the spacer keep clear (TASK-554).
                  bottom: keyboardBand(keyboardHeight),
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

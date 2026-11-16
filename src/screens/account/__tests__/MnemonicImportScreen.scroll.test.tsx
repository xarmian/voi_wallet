/**
 * TASK-554 — the active recovery-word field stays fully visible above the
 * keyboard and the word-suggestions bar, and a manual scroll is never undone.
 *
 * The screen turns off the keyboard-aware library's automatic scroll for its
 * word grid and reveals the focused field itself (computeRevealOffset): only
 * when a field gains focus or the keyboard shows or resizes, only when the
 * field is not already fully visible, and by the minimal offset. The library
 * component is replaced by a plain ScrollView that records its props and its
 * scrollToPosition calls; layout and scroll events are fired by hand.
 *
 * Runs once per platform: iOS listens to keyboardWillShow, Android to
 * keyboardDidShow, and Android's reported keyboard height leaves out the
 * navigation-bar inset, which the screen adds back.
 */

import React from 'react';
import { Alert, DeviceEventEmitter, Platform } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import { computeRevealOffset } from '@/utils/scrollReveal';

jest.mock('@/services/wallet', () => ({}));

jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({ importAccount: jest.fn() }),
}));

jest.mock('@react-navigation/native', () => ({
  CommonActions: { reset: jest.fn(), navigate: jest.fn() },
  useFocusEffect: () => {},
}));

// The screen reads the tab bar height from bottom-tabs; the real module needs
// the full navigation library, which is mocked above.
jest.mock('@react-navigation/bottom-tabs', () => ({
  BottomTabBarHeightContext: require('react').createContext(undefined),
}));

const NAV_BAR_INSET = 24;
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
  };
});

jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: () => {} }));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

// Render every grid row (a test renderer has no layout pass to window them).
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = jest.requireActual('react');
  const ActualFlatList = jest.requireActual(
    'react-native/Libraries/Lists/FlatList'
  ).default;
  const FullFlatList = ReactActual.forwardRef(
    (props: { data?: unknown[] }, ref: unknown) =>
      ReactActual.createElement(ActualFlatList, {
        ...props,
        ref,
        initialNumToRender: props.data?.length ?? 10,
      })
  );
  return { __esModule: true, default: FullFlatList };
});

const mockScrollToPosition = jest.fn();
const mockLibraryProps = jest.fn();
jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const ReactActual = jest.requireActual('react');
  const { ScrollView } = jest.requireActual('react-native');
  const KeyboardAwareScrollView = ReactActual.forwardRef(
    (props: Record<string, unknown>, ref: unknown) => {
      ReactActual.useImperativeHandle(ref, () => ({
        scrollToPosition: (...args: unknown[]) => mockScrollToPosition(...args),
      }));
      mockLibraryProps(props);
      return ReactActual.createElement(ScrollView, props);
    }
  );
  return { KeyboardAwareScrollView };
});

import MnemonicImportScreen from '../MnemonicImportScreen';

type Screen = Awaited<ReturnType<typeof render>>;

// Must match the screen's constants.
const REVEAL_MARGIN = 12;
const SUGGESTION_BAR_FALLBACK_HEIGHT = 56;

// Layout fixture: a 600-high scroll viewport; the grid at the top of the
// scroll content; row r at 20 + 68r (68 = a 56-high field plus a 12 gap).
const VIEWPORT_HEIGHT = 600;
const ROW_PITCH = 68;
const FIELD_HEIGHT = 56;
const rowTop = (row: number) => 20 + row * ROW_PITCH;
const fieldTop = (index: number) => rowTop(Math.floor(index / 2));

const layoutEvent = (y: number, height: number) => ({
  nativeEvent: { layout: { x: 0, y, width: 390, height } },
});

async function renderLaidOut(): Promise<Screen> {
  const screen = await render(
    <MnemonicImportScreen
      navigation={
        {
          navigate: jest.fn(),
          goBack: jest.fn(),
          dispatch: jest.fn(),
          canGoBack: () => true,
          getParent: () => undefined,
          getState: jest.fn(() => ({ type: 'stack', routes: [] })),
        } as never
      }
      route={{ params: { isOnboarding: true } } as never}
    />
  );
  await fireEvent(
    screen.getByTestId('mnemonic-word-scroll'),
    'layout',
    layoutEvent(0, VIEWPORT_HEIGHT)
  );
  await fireEvent(
    screen.getByTestId('mnemonic-word-grid'),
    'layout',
    layoutEvent(0, 13 * ROW_PITCH + 40)
  );
  for (let row = 0; row < 13; row++) {
    await fireEvent(
      screen.getByTestId(`mnemonic-word-row-${row}`),
      'layout',
      layoutEvent(rowTop(row), ROW_PITCH)
    );
  }
  for (let i = 0; i < 25; i++) {
    await fireEvent(
      screen.getByTestId(`mnemonic-word-cell-${i}`),
      'layout',
      layoutEvent(0, FIELD_HEIGHT)
    );
  }
  return screen;
}

const field = (screen: Screen, index: number) =>
  screen.getByPlaceholderText(`Word ${index + 1}`);

async function focusField(screen: Screen, index: number) {
  await fireEvent(field(screen, index), 'focus');
}

async function blurField(screen: Screen, index: number) {
  await fireEvent(field(screen, index), 'blur');
}

async function scrollBy(screen: Screen, y: number) {
  await fireEvent.scroll(screen.getByTestId('mnemonic-word-scroll'), {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { width: 390, height: 1400 },
      layoutMeasurement: { width: 390, height: VIEWPORT_HEIGHT },
    },
  });
}

describe.each(['ios', 'android'] as const)(
  'MnemonicImportScreen word-field reveal on %s (TASK-554)',
  (os) => {
    const originalOS = Platform.OS;
    const showEvent = os === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = os === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    // The keyboard band as the screen computes it (no tab bar in this test).
    const keyboardBand = (height: number) =>
      height + (os === 'android' ? NAV_BAR_INSET : 0);

    const expectedOffset = (
      top: number,
      scrollY: number,
      keyboardHeight: number,
      barHeight: number = SUGGESTION_BAR_FALLBACK_HEIGHT
    ) =>
      computeRevealOffset({
        fieldTop: top,
        fieldHeight: FIELD_HEIGHT,
        scrollY,
        viewportHeight: VIEWPORT_HEIGHT,
        obscuredBottom: keyboardBand(keyboardHeight) + barHeight,
        margin: REVEAL_MARGIN,
      });

    async function showKeyboard(height: number) {
      await act(async () => {
        DeviceEventEmitter.emit(showEvent, {
          endCoordinates: { height, screenY: 844 - height, screenX: 0 },
        });
      });
    }

    async function hideKeyboard() {
      await act(async () => {
        DeviceEventEmitter.emit(hideEvent, {
          endCoordinates: { height: 0, screenY: 844, screenX: 0 },
        });
      });
    }

    beforeEach(() => {
      Platform.OS = os;
      jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    });

    afterEach(() => {
      Platform.OS = originalOS;
      jest.restoreAllMocks();
      jest.clearAllMocks();
    });

    it('turns off the library automatic scroll and its reset-on-hide scroll for the word grid', async () => {
      await renderLaidOut();
      const props = mockLibraryProps.mock.calls.at(-1)?.[0];
      expect(props.enableAutomaticScroll).toBe(false);
      expect(props.enableResetScrollToCoords).toBe(false);
    });

    it('a field above the keyboard but behind the suggestions bar is scrolled into view, minimally', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);
      // Field 7 (row 3, 224..280) is above the keyboard's top edge but under
      // the suggestions bar: the reported bug.
      await focusField(screen, 6);

      const offset = expectedOffset(fieldTop(6), 0, 300);
      expect(offset).not.toBeNull();
      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
      expect(mockScrollToPosition).toHaveBeenCalledWith(0, offset, true);
    });

    it('a fully visible field gets no scroll call', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);
      expect(expectedOffset(fieldTop(4), 0, 300)).toBeNull();

      await focusField(screen, 0);
      await blurField(screen, 0);
      await focusField(screen, 2);
      await blurField(screen, 2);
      await focusField(screen, 4);

      expect(mockScrollToPosition).not.toHaveBeenCalled();
    });

    it('first focus before the keyboard height is known reveals once the keyboard shows', async () => {
      const screen = await renderLaidOut();
      await focusField(screen, 6);
      expect(mockScrollToPosition).not.toHaveBeenCalled();

      await showKeyboard(300);

      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
      expect(mockScrollToPosition).toHaveBeenCalledWith(
        0,
        expectedOffset(fieldTop(6), 0, 300),
        true
      );
    });

    it("the previous field's blur arriving after the next field's focus does not lose the focused field", async () => {
      const screen = await renderLaidOut();
      await focusField(screen, 5);
      await focusField(screen, 6);
      await blurField(screen, 5);

      await showKeyboard(300);

      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
      expect(mockScrollToPosition).toHaveBeenCalledWith(
        0,
        expectedOffset(fieldTop(6), 0, 300),
        true
      );
    });

    it('advancing while the keyboard is up does not jump: a repeated same-height keyboard event scrolls nothing', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);
      await focusField(screen, 4);
      await blurField(screen, 4);
      // Keyboard "next": iOS re-sends keyboardWillShow with the same height on
      // every focus change while the keyboard is up.
      await fireEvent(field(screen, 4), 'submitEditing');
      await focusField(screen, 5);
      await showKeyboard(300);
      expect(mockScrollToPosition).not.toHaveBeenCalled();

      // Even with the focused field scrolled out of view by hand, a re-sent
      // event with an unchanged height is not a show or a resize: no scroll.
      await scrollBy(screen, 300);
      await showKeyboard(300);

      expect(mockScrollToPosition).not.toHaveBeenCalled();
    });

    it('never overrides a manual scroll: visible after scrolling by hand means no scroll; out of view means exactly one minimal scroll', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);

      // Scroll by hand so field 7 is fully visible, then focus it.
      await scrollBy(screen, 100);
      expect(expectedOffset(fieldTop(6), 100, 300)).toBeNull();
      await focusField(screen, 6);
      expect(mockScrollToPosition).not.toHaveBeenCalled();
      await blurField(screen, 6);

      // Scroll it out of view (above the top), then focus it again.
      await scrollBy(screen, 300);
      await focusField(screen, 6);

      const offset = expectedOffset(fieldTop(6), 300, 300);
      expect(offset).toBe(fieldTop(6) - REVEAL_MARGIN);
      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
      expect(mockScrollToPosition).toHaveBeenCalledWith(0, offset, true);
    });

    it('a keyboard resize re-reveals the focused field', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);
      await focusField(screen, 4);
      expect(mockScrollToPosition).not.toHaveBeenCalled();

      await showKeyboard(350);

      const offset = expectedOffset(fieldTop(4), 0, 350);
      expect(offset).not.toBeNull();
      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
      expect(mockScrollToPosition).toHaveBeenCalledWith(0, offset, true);
    });

    it('typing, suggestion updates and layout passes never scroll', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);
      await focusField(screen, 6);
      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);

      await fireEvent.changeText(field(screen, 6), 'a');
      await fireEvent.changeText(field(screen, 6), 'ab');
      await fireEvent(
        screen.getByTestId('mnemonic-word-suggestions'),
        'layout',
        layoutEvent(400, 60)
      );
      await fireEvent(
        screen.getByTestId('mnemonic-word-grid'),
        'layout',
        layoutEvent(0, 13 * ROW_PITCH + 40)
      );
      await scrollBy(screen, 10);

      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
    });

    it('uses the suggestions bar measured height once it has laid out', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);
      await focusField(screen, 4);
      await fireEvent.changeText(field(screen, 4), 'ab');
      await fireEvent(
        screen.getByTestId('mnemonic-word-suggestions'),
        'layout',
        layoutEvent(400, 100)
      );
      await blurField(screen, 4);
      expect(mockScrollToPosition).not.toHaveBeenCalled();

      await focusField(screen, 4);

      const offset = expectedOffset(fieldTop(4), 0, 300, 100);
      expect(offset).not.toBeNull();
      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
      expect(mockScrollToPosition).toHaveBeenCalledWith(0, offset, true);
    });

    it('a hidden keyboard covers nothing: focusing a low field without the keyboard does not scroll', async () => {
      const screen = await renderLaidOut();
      await showKeyboard(300);
      await hideKeyboard();
      await focusField(screen, 6);

      expect(mockScrollToPosition).not.toHaveBeenCalled();
    });

    it('reveals the account-name field above the keyboard', async () => {
      const screen = await renderLaidOut();
      await fireEvent(
        screen.getByTestId('mnemonic-account-name'),
        'layout',
        layoutEvent(1000, 80)
      );
      await showKeyboard(300);
      await fireEvent(
        screen.getByPlaceholderText('Imported account name'),
        'focus'
      );

      // The suggestions bar never shows for this field: keyboard band only.
      const offset = computeRevealOffset({
        fieldTop: 1000,
        fieldHeight: 80,
        scrollY: 0,
        viewportHeight: VIEWPORT_HEIGHT,
        obscuredBottom: keyboardBand(300),
        margin: REVEAL_MARGIN,
      });
      expect(mockScrollToPosition).toHaveBeenCalledTimes(1);
      expect(mockScrollToPosition).toHaveBeenCalledWith(0, offset, true);
    });
  }
);

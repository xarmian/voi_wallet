import React, { forwardRef } from 'react';
import { KeyboardAwareScrollView as KeyboardAwareScrollViewLib } from 'react-native-keyboard-aware-scroll-view';
import { useThemeColors } from '@/hooks/useThemedStyles';
import { Platform } from 'react-native';

// Widen the wrapper's props to the underlying component's full prop surface so
// callers can pass ScrollView props (onScroll, scrollEventThrottle,
// refreshControl, etc.) and a ref in addition to the keyboard-aware options.
type KeyboardAwareScrollViewProps = React.ComponentProps<
  typeof KeyboardAwareScrollViewLib
>;

const KeyboardAwareScrollView = forwardRef<
  KeyboardAwareScrollViewLib,
  KeyboardAwareScrollViewProps
>(function KeyboardAwareScrollView(
  {
    children,
    style,
    contentContainerStyle,
    extraScrollHeight = 20,
    extraHeight,
    keyboardShouldPersistTaps = 'handled',
    showsVerticalScrollIndicator = false,
    enableOnAndroid = true,
    scrollEnabled = true,
    enableAutomaticScroll = true,
    ...props
  },
  ref
) {
  useThemeColors();

  return (
    <KeyboardAwareScrollViewLib
      ref={ref}
      style={style}
      contentContainerStyle={contentContainerStyle}
      extraScrollHeight={extraScrollHeight}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      enableOnAndroid={enableOnAndroid}
      scrollEnabled={scrollEnabled}
      // Additional props for better behavior
      enableAutomaticScroll={enableAutomaticScroll}
      keyboardOpeningTime={Platform.OS === 'android' ? 500 : 250}
      extraHeight={
        typeof extraHeight === 'number'
          ? extraHeight
          : Platform.OS === 'android'
            ? 30
            : 20
      }
      {...props}
    >
      {children}
    </KeyboardAwareScrollViewLib>
  );
});

export default KeyboardAwareScrollView;

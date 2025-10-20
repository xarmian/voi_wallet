import React from 'react';
import { KeyboardAwareScrollView as KeyboardAwareScrollViewLib } from 'react-native-keyboard-aware-scroll-view';
import { useThemeColors } from '@/hooks/useThemedStyles';
import { Platform } from 'react-native';

interface KeyboardAwareScrollViewProps {
  children: React.ReactNode;
  style?: any;
  contentContainerStyle?: any;
  extraScrollHeight?: number;
  extraHeight?: number;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
  showsVerticalScrollIndicator?: boolean;
  enableOnAndroid?: boolean;
  scrollEnabled?: boolean;
  enableAutomaticScroll?: boolean;
}

export default function KeyboardAwareScrollView({
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
}: KeyboardAwareScrollViewProps) {
  const themeColors = useThemeColors();

  return (
    <KeyboardAwareScrollViewLib
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
}
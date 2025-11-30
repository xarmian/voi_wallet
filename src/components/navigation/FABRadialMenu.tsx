/**
 * FABRadialMenu - Floating Action Button with radial expandable menu
 *
 * Replaces the center Discover button with an animated menu that fans out
 * in a circular arc, providing quick access to key wallet actions.
 */

import React, { useCallback, useMemo } from 'react';
import {
  View,
  StyleSheet,
  TouchableWithoutFeedback,
  TouchableOpacity,
  Text,
  Dimensions,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  interpolate,
  runOnJS,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, CommonActions, TabActions } from '@react-navigation/native';
import { useTheme } from '@/contexts/ThemeContext';
import { springConfigs, timingConfigs } from '@/utils/animations';
import { GlassCard } from '@/components/common/GlassCard';
import { useActiveAccount } from '@/store/walletStore';

// Menu item configuration
interface MenuItem {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  screen: string;
  stackScreen?: string;
}

const MENU_ITEMS: MenuItem[] = [
  { id: 'discover', label: 'Discover Voi', icon: 'compass', screen: 'Discover' },
  { id: 'swap', label: 'Swap Tokens', icon: 'swap-horizontal', screen: 'Home', stackScreen: 'Swap' },
  { id: 'send', label: 'Send Tokens', icon: 'arrow-up', screen: 'Home', stackScreen: 'Send' },
  { id: 'receive', label: 'Receive Tokens', icon: 'arrow-down', screen: 'Home', stackScreen: 'Receive' },
];

// Vertical stack positioning constants
const ITEM_HEIGHT = 52;   // Height of each menu item including gap
const ITEM_GAP = 12;      // Gap between items
const FIRST_ITEM_OFFSET = 80; // Distance from FAB center to first item

// Individual menu item component
interface FABMenuItemProps {
  item: MenuItem;
  index: number;
  totalItems: number;
  menuProgress: Animated.SharedValue<number>;
  onPress: () => void;
}

const FABMenuItem: React.FC<FABMenuItemProps> = ({
  item,
  index,
  totalItems,
  menuProgress,
  onPress,
}) => {
  const { theme } = useTheme();

  // Calculate vertical position - items stack upward from the FAB
  // Reverse index so first item in array appears at bottom of stack (closest to FAB)
  const reverseIndex = totalItems - 1 - index;
  const targetY = -(FIRST_ITEM_OFFSET + reverseIndex * (ITEM_HEIGHT + ITEM_GAP));

  const animatedStyle = useAnimatedStyle(() => {
    const progress = menuProgress.value;
    // Stagger based on reverse index (bottom items animate first)
    const staggeredProgress = interpolate(
      progress,
      [reverseIndex * 0.08, 0.3 + reverseIndex * 0.12],
      [0, 1],
      'clamp'
    );

    return {
      transform: [
        { translateY: interpolate(staggeredProgress, [0, 1], [0, targetY]) },
        { scale: interpolate(staggeredProgress, [0, 0.5, 1], [0.5, 0.9, 1]) },
      ],
      opacity: interpolate(staggeredProgress, [0, 0.4, 1], [0, 0.7, 1]),
    };
  });

  return (
    <Animated.View style={[styles.menuItemWrapper, animatedStyle]}>
      <GlassCard
        variant="medium"
        padding="sm"
        onPress={onPress}
        borderRadius={16}
        style={styles.menuItemCard}
        borderColor={theme.colors.border}
      >
        <View style={styles.menuItemContent}>
          <View style={[styles.menuItemIconContainer, { backgroundColor: theme.colors.primary + '20' }]}>
            <Ionicons name={item.icon} size={20} color={theme.colors.primary} />
          </View>
          <Text style={[styles.menuItemLabel, { color: theme.colors.text }]} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
      </GlassCard>
    </Animated.View>
  );
};

// Main FAB Radial Menu component
interface FABRadialMenuProps {
  bottomOffset?: number;
}

// Default offset positions the button to overlap the tab bar top (like original design)
export const FABRadialMenu: React.FC<FABRadialMenuProps> = ({ bottomOffset = 20 }) => {
  const { theme } = useTheme();
  const navigation = useNavigation<any>();
  const activeAccount = useActiveAccount();

  // Animation shared values
  const menuProgress = useSharedValue(0);
  const buttonRotation = useSharedValue(0);
  const isOpen = useSharedValue(false);

  // Open menu animation
  const openMenu = useCallback(() => {
    isOpen.value = true;
    menuProgress.value = withSpring(1, springConfigs.bouncy);
    buttonRotation.value = withSpring(180, springConfigs.snappy);
  }, [menuProgress, buttonRotation, isOpen]);

  // Close menu animation
  const closeMenu = useCallback(() => {
    isOpen.value = false;
    menuProgress.value = withSpring(0, springConfigs.snappy);
    buttonRotation.value = withSpring(0, springConfigs.snappy);
  }, [menuProgress, buttonRotation, isOpen]);

  // Toggle menu
  const toggleMenu = useCallback(() => {
    if (isOpen.value) {
      closeMenu();
    } else {
      openMenu();
    }
  }, [isOpen, openMenu, closeMenu]);

  // Handle menu item press
  const handleItemPress = useCallback((item: MenuItem) => {
    closeMenu();

    // Navigate after a short delay for visual feedback
    const navigateToScreen = () => {
      if (item.stackScreen) {
        // Navigate to nested stack screen (Send, Swap, Receive in WalletStack)
        // Use Main -> Tab -> Stack screen navigation path
        const params = item.stackScreen === 'Swap' && activeAccount
          ? { accountId: activeAccount.address }
          : {};
        navigation.navigate('Main', {
          screen: item.screen,
          params: {
            screen: item.stackScreen,
            params,
          },
        });
      } else {
        // Direct tab navigation (Discover)
        // Navigate through Main to reach the tab
        navigation.navigate('Main', {
          screen: item.screen,
        });
      }
    };

    setTimeout(navigateToScreen, 150);
  }, [navigation, activeAccount, closeMenu]);

  // Backdrop animated style
  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(menuProgress.value, [0, 1], [0, 0.65]),
    pointerEvents: menuProgress.value > 0.1 ? 'auto' : 'none',
  }));

  // Button rotation style
  const buttonIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${buttonRotation.value}deg` }],
  }));

  // Compass icon opacity (fades out)
  const compassOpacityStyle = useAnimatedStyle(() => ({
    opacity: interpolate(menuProgress.value, [0, 0.4], [1, 0]),
    position: 'absolute' as const,
  }));

  // Close icon opacity (fades in)
  const closeIconOpacityStyle = useAnimatedStyle(() => ({
    opacity: interpolate(menuProgress.value, [0.4, 0.8], [0, 1]),
    position: 'absolute' as const,
  }));

  // Menu container style (for pointer events)
  const menuContainerStyle = useAnimatedStyle(() => ({
    pointerEvents: menuProgress.value > 0 ? 'auto' : 'box-none',
  }));

  return (
    <>
      {/* Dark backdrop overlay */}
      <Animated.View
        style={[styles.backdrop, backdropAnimatedStyle]}
      >
        <TouchableWithoutFeedback onPress={closeMenu}>
          <View style={StyleSheet.absoluteFill} />
        </TouchableWithoutFeedback>
      </Animated.View>

      {/* Menu items and FAB button container */}
      <Animated.View
        style={[
          styles.menuContainer,
          { bottom: bottomOffset },
          menuContainerStyle,
        ]}
        pointerEvents="box-none"
      >
        {/* Menu items - positioned radially around center */}
        {MENU_ITEMS.map((item, index) => (
          <FABMenuItem
            key={item.id}
            item={item}
            index={index}
            totalItems={MENU_ITEMS.length}
            menuProgress={menuProgress}
            onPress={() => handleItemPress(item)}
          />
        ))}

        {/* Center FAB button */}
        <TouchableOpacity
          style={[
            styles.fabButton,
            { backgroundColor: theme.colors.primary },
            theme.shadows.md,
          ]}
          onPress={toggleMenu}
          activeOpacity={0.8}
        >
          <Animated.View style={buttonIconStyle}>
            {/* Compass icon (visible when closed) */}
            <Animated.View style={compassOpacityStyle}>
              <Ionicons name="compass" size={28} color="white" />
            </Animated.View>
            {/* Close icon (visible when open) */}
            <Animated.View style={closeIconOpacityStyle}>
              <Ionicons name="close" size={28} color="white" />
            </Animated.View>
            {/* Invisible placeholder for sizing */}
            <Ionicons name="compass" size={28} color="transparent" />
          </Animated.View>
        </TouchableOpacity>
      </Animated.View>
    </>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 1)',
    zIndex: 999,
  },
  menuContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  fabButton: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuItemWrapper: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuItemCard: {
    width: 160,
  },
  menuItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  menuItemIconContainer: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuItemLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});

export default FABRadialMenu;

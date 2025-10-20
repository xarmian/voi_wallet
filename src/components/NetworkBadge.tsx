import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { Theme } from '@/constants/themes';
import { useThemedStyles } from '@/hooks/useThemedStyles';

interface NetworkBadgeProps {
  networkId: NetworkId;
  size?: 'small' | 'medium' | 'large';
  variant?: 'filled' | 'outlined' | 'minimal';
}

const NetworkBadge: React.FC<NetworkBadgeProps> = ({
  networkId,
  size = 'medium',
  variant = 'filled',
}) => {
  const styles = useThemedStyles(createStyles);
  const networkConfig = getNetworkConfig(networkId);

  const sizeStyles = {
    small: styles.sizeSmall,
    medium: styles.sizeMedium,
    large: styles.sizeLarge,
  };

  const variantStyles = {
    filled: [
      styles.variantFilled,
      { backgroundColor: networkConfig.color },
    ],
    outlined: [
      styles.variantOutlined,
      { borderColor: networkConfig.color },
    ],
    minimal: styles.variantMinimal,
  };

  const textStyles = {
    filled: styles.textFilled,
    outlined: { color: networkConfig.color, fontWeight: '600' },
    minimal: { color: networkConfig.color, fontWeight: '600' },
  };

  const sizeTextStyles = {
    small: styles.textSmall,
    medium: styles.textMedium,
    large: styles.textLarge,
  };

  return (
    <View style={[styles.badge, sizeStyles[size], variantStyles[variant]]}>
      <Text
        style={[textStyles[variant], sizeTextStyles[size]]}
        numberOfLines={1}
      >
        {networkConfig.currency}
      </Text>
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    badge: {
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
    },

    // Size variants
    sizeSmall: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 8,
    },
    sizeMedium: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 10,
    },
    sizeLarge: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 12,
    },

    // Style variants
    variantFilled: {},
    variantOutlined: {
      borderWidth: 1,
      backgroundColor: 'transparent',
    },
    variantMinimal: {
      backgroundColor: 'transparent',
    },

    // Text styles by variant
    textFilled: {
      color: '#FFFFFF',
      fontWeight: '600',
    },

    // Text sizes
    textSmall: {
      fontSize: 10,
    },
    textMedium: {
      fontSize: 12,
    },
    textLarge: {
      fontSize: 14,
    },
  });

export default NetworkBadge;
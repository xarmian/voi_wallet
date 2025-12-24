import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ClaimableItem } from '@/types/claimable';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { normalizeAssetImageUrl } from '@/utils/assetImages';

interface ClaimableTokenItemProps {
  item: ClaimableItem;
  onPress: () => void;
  isHidden?: boolean;
}

/**
 * Formats a bigint token amount for display with proper decimals
 */
function formatTokenAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  if (fractionalPart === 0n) {
    return wholePart.toLocaleString();
  }

  // Pad fractional part with leading zeros if needed
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  // Trim trailing zeros
  const trimmedFractional = fractionalStr.replace(/0+$/, '');
  // Limit to 6 decimal places for display
  const displayFractional = trimmedFractional.slice(0, 6);

  return `${wholePart.toLocaleString()}.${displayFractional}`;
}

/**
 * Abbreviates an address for display (first 6 + last 4 chars)
 */
function abbreviateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function ClaimableTokenItem({
  item,
  onPress,
  isHidden = false,
}: ClaimableTokenItemProps) {
  const [imageError, setImageError] = useState(false);
  const styles = useThemedStyles(createStyles);

  const formattedAmount = formatTokenAmount(item.amount, item.tokenDecimals);
  const ownerDisplay = item.ownerEnvoiName || abbreviateAddress(item.owner);

  const renderTokenImage = () => {
    const normalizedImageUrl = normalizeAssetImageUrl(item.tokenImageUrl);

    if (!normalizedImageUrl || imageError) {
      return (
        <View style={styles.placeholderIcon}>
          <Ionicons
            name="disc"
            size={24}
            color={styles.placeholderIcon.color}
          />
        </View>
      );
    }

    return (
      <Image
        source={{ uri: normalizedImageUrl }}
        style={styles.tokenImage}
        onError={() => setImageError(true)}
      />
    );
  };

  return (
    <TouchableOpacity
      style={[styles.container, isHidden && styles.containerHidden]}
      onPress={onPress}
      disabled={!item.isClaimable}
    >
      <View style={styles.leftSection}>
        <View style={styles.imageContainer}>
          {renderTokenImage()}
          {isHidden && (
            <View style={styles.hiddenOverlay}>
              <Ionicons name="eye-off" size={16} color="white" />
            </View>
          )}
        </View>
        <View style={styles.tokenInfo}>
          <View style={styles.tokenNameRow}>
            <Text
              style={[styles.tokenName, isHidden && styles.textHidden]}
              numberOfLines={1}
            >
              {item.tokenName}
            </Text>
            {item.tokenVerified && (
              <Ionicons
                name="checkmark-circle"
                size={14}
                color={styles.verifiedIcon.color}
                style={styles.verifiedIcon}
              />
            )}
          </View>
          <Text
            style={[styles.ownerText, isHidden && styles.textHidden]}
            numberOfLines={1}
          >
            From: {ownerDisplay}
          </Text>
        </View>
      </View>

      <View style={styles.rightSection}>
        <View style={styles.amountContainer}>
          <Text
            style={[styles.amount, isHidden && styles.textHidden]}
            numberOfLines={1}
          >
            {formattedAmount}
          </Text>
          <Text
            style={[styles.symbol, isHidden && styles.textHidden]}
            numberOfLines={1}
          >
            {item.tokenSymbol}
          </Text>
        </View>
        {!item.isClaimable && (
          <View style={styles.insufficientBadge}>
            <Text style={styles.insufficientText}>Insufficient</Text>
          </View>
        )}
        {item.isClaimable && !isHidden && (
          <Ionicons
            name="chevron-forward"
            size={16}
            color={styles.chevron.color}
          />
        )}
      </View>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
      marginBottom: 8,
    },
    containerHidden: {
      opacity: 0.6,
    },
    leftSection: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    imageContainer: {
      position: 'relative',
    },
    tokenImage: {
      width: 44,
      height: 44,
      borderRadius: 22,
      marginRight: 12,
    },
    placeholderIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.colors.surfaceAlt,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
      color: theme.colors.primary,
    },
    hiddenOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    tokenInfo: {
      flex: 1,
      marginRight: 8,
    },
    tokenNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    tokenName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      flexShrink: 1,
    },
    verifiedIcon: {
      marginLeft: 4,
      color: theme.colors.success,
    },
    ownerText: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    textHidden: {
      color: theme.colors.textMuted,
    },
    rightSection: {
      alignItems: 'flex-end',
      flexDirection: 'row',
      gap: 8,
    },
    amountContainer: {
      alignItems: 'flex-end',
    },
    amount: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    symbol: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    insufficientBadge: {
      backgroundColor: theme.colors.error + '20',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: theme.borderRadius.sm,
    },
    insufficientText: {
      fontSize: 11,
      color: theme.colors.error,
      fontWeight: '500',
    },
    chevron: {
      color: theme.colors.textMuted,
    },
  });

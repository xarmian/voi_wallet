import React, { useState, useEffect } from 'react';
import { View, StyleSheet, Text, Image } from 'react-native';
import Svg, { Circle, Rect, Polygon } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import EnvoiService from '@/services/envoi';
import AvatarCacheService from '@/services/avatarCache';
import {
  AccountMetadata,
  AccountType,
  RekeyedAccountMetadata,
} from '@/types/wallet';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useWalletStore } from '@/store/walletStore';

// Shared cache for avatar URLs across all AccountAvatar instances
const avatarUrlCache = new Map<string, string | null>();
const avatarLoadingState = new Map<string, boolean>();
const avatarCallbacks = new Map<string, Set<(url: string | null) => void>>();

interface AccountAvatarProps {
  address: string;
  size?: number;
  showActiveIndicator?: boolean;
  useEnvoiAvatar?: boolean;
  fallbackToGenerated?: boolean;
  account?: AccountMetadata; // Optional account metadata for rekey indicators
  showRekeyIndicator?: boolean;
}

// Generate deterministic colors from address
const generateColors = (safeAddress: string): string[] => {
  // Ensure we have a valid string and normalize it
  const normalizedAddress = safeAddress || 'default';
  const hash = normalizedAddress.toLowerCase().replace(/[^a-f0-9]/g, '0');

  // Pad hash if too short
  const paddedHash = (hash + '0'.repeat(24)).slice(0, 24);
  const colors = [];

  for (let i = 0; i < 3; i++) {
    const start = i * 8;
    const end = start + 8;
    const hexChunk = paddedHash.slice(start, end);
    const value = parseInt(hexChunk, 16);

    // Ensure we have valid numbers
    const safeValue = isNaN(value)
      ? Math.floor(Math.random() * 0xffffff)
      : value;

    // Generate pleasing colors by constraining HSL values
    const hue = safeValue % 360;
    const saturation = 65 + (safeValue % 25); // 65-90%
    const lightness = 45 + (safeValue % 20); // 45-65%

    colors.push(`hsl(${hue}, ${saturation}%, ${lightness}%)`);
  }

  return colors;
};

// Generate geometric pattern based on address
const generatePattern = (safeAddress: string, size: number) => {
  const hash = safeAddress.toLowerCase().replace(/[^a-f0-9]/g, '0');
  const paddedHash = (hash + '0'.repeat(12)).slice(0, 12);
  const colors = generateColors(safeAddress);
  const patterns = [];

  // Create deterministic pattern based on address hash
  for (let i = 0; i < 6; i++) {
    const charValue = parseInt(paddedHash[i] || '0', 16);
    const patternType = charValue % 3;
    const colorIndex = charValue % 3;
    const x = (charValue % 4) * (size / 4);
    const y = (Math.floor(charValue / 4) % 4) * (size / 4);
    const elementSize = size / 8;

    switch (patternType) {
      case 0: // Circle
        patterns.push(
          <Circle
            key={`circle-${i}`}
            cx={x + elementSize}
            cy={y + elementSize}
            r={elementSize / 2}
            fill={colors[colorIndex]}
          />
        );
        break;
      case 1: // Rectangle
        patterns.push(
          <Rect
            key={`rect-${i}`}
            x={x}
            y={y}
            width={elementSize}
            height={elementSize}
            fill={colors[colorIndex]}
          />
        );
        break;
      case 2: // Triangle
        const points = `${x},${y + elementSize} ${x + elementSize / 2},${y} ${x + elementSize},${y + elementSize}`;
        patterns.push(
          <Polygon
            key={`triangle-${i}`}
            points={points}
            fill={colors[colorIndex]}
          />
        );
        break;
    }
  }

  return patterns;
};

const getReadableTextColor = (color: string): string => {
  const hslMatch = color.match(
    /hsl\(\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)%,\s*(-?\d+(?:\.\d+)?)%\s*\)/i
  );

  if (hslMatch) {
    const lightness = parseFloat(hslMatch[3]);
    if (!Number.isNaN(lightness)) {
      return lightness >= 58 ? '#111827' : '#FFFFFF';
    }
  }

  return '#FFFFFF';
};

export default function AccountAvatar({
  address,
  size = 32,
  showActiveIndicator = false,
  useEnvoiAvatar = true,
  fallbackToGenerated = true,
  account,
  showRekeyIndicator = true,
}: AccountAvatarProps) {
  const styles = useThemedStyles(createStyles);
  const [envoiAvatarUrl, setEnvoiAvatarUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);


  const safeAddress = address || 'default';
  const colors = generateColors(safeAddress);
  const initialsColor = getReadableTextColor(colors[0]);
  const patterns = generatePattern(safeAddress, size);

  // Fallback to initials if SVG fails
  const initials = address?.slice(0, 2).toUpperCase() || '??';

  // Load Envoi avatar if enabled
  useEffect(() => {
    if (!useEnvoiAvatar || !address) {
      return;
    }

    let initialUrl: string | null = null;

    if (account?.avatarUrl) {
      initialUrl = account.avatarUrl;
      setEnvoiAvatarUrl(account.avatarUrl);
      setIsLoading(false);
      setAvatarError(false);
      avatarUrlCache.set(address, account.avatarUrl);
    }

    // Check if store already has avatar data for this address (don't use as dependency to avoid loops)
    const store = useWalletStore.getState();
    const storeAccount = store.wallet?.accounts.find(
      (candidate) => candidate.address === address
    );

    const persistedAvatar =
      storeAccount?.avatarUrl ??
      (storeAccount ? store.accountStates[storeAccount.id]?.envoiName?.avatar : null);

    if (persistedAvatar && persistedAvatar !== initialUrl) {
      initialUrl = persistedAvatar;
      setEnvoiAvatarUrl(persistedAvatar);
      setIsLoading(false);
      setAvatarError(false);
      avatarUrlCache.set(address, persistedAvatar);
    } else if (avatarUrlCache.has(address)) {
      const cachedUrl = avatarUrlCache.get(address);
      initialUrl = cachedUrl || null;
      setEnvoiAvatarUrl(initialUrl);
      setIsLoading(false);
      if (cachedUrl) {
        setAvatarError(false);
      }
    }

    // Register callback for this instance
    const updateCallback = (url: string | null) => {
      setEnvoiAvatarUrl(url);
      setIsLoading(false);
      if (url) {
        setAvatarError(false);
      }
    };

    if (!avatarCallbacks.has(address)) {
      avatarCallbacks.set(address, new Set());
    }
    avatarCallbacks.get(address)!.add(updateCallback);

    if (initialUrl) {
      return () => {
        avatarCallbacks.get(address)?.delete(updateCallback);
      };
    }

    // Check if already loading
    if (avatarLoadingState.get(address)) {
      setIsLoading(true);
      return () => {
        avatarCallbacks.get(address)?.delete(updateCallback);
      };
    }

    // Start loading
    avatarLoadingState.set(address, true);
    setIsLoading(true);

    const loadEnvoiAvatar = async () => {
      try {
        const envoiService = EnvoiService.getInstance();
        const avatarUrl = await envoiService.getAvatarUrl(address, size > 64);

        let finalUrl: string | null = null;

        if (avatarUrl) {
          // Check cache first
          const avatarCache = AvatarCacheService.getInstance();
          let cachedUrl = await avatarCache.getCachedAvatar(avatarUrl);

          if (!cachedUrl) {
            // Cache the avatar in background, but use original URL immediately
            avatarCache.cacheAvatar(avatarUrl).catch((error) => {
              console.warn('[AccountAvatar] Failed to cache avatar:', error);
            });
            cachedUrl = avatarUrl;
          }

          finalUrl = cachedUrl;
        }

        // Update shared cache
        avatarUrlCache.set(address, finalUrl);
        avatarLoadingState.set(address, false);

        // Notify all instances
        const callbacks = avatarCallbacks.get(address);
        if (callbacks) {
          callbacks.forEach((callback) => callback(finalUrl));
        }
      } catch (error) {
        console.warn('Failed to load Envoi avatar:', error);

        // Update shared cache with null
        avatarUrlCache.set(address, null);
        avatarLoadingState.set(address, false);

        // Notify all instances
        const callbacks = avatarCallbacks.get(address);
        if (callbacks) {
          callbacks.forEach((callback) => callback(null));
        }
      }
    };

    loadEnvoiAvatar();

    return () => {
      avatarCallbacks.get(address)?.delete(updateCallback);
    };
  }, [address, useEnvoiAvatar, size]);

  const handleAvatarError = () => {
    setAvatarError(true);
  };

  // Determine what to show
  const shouldShowEnvoiAvatar =
    useEnvoiAvatar && envoiAvatarUrl && !avatarError;
  const shouldShowGenerated =
    fallbackToGenerated && (!useEnvoiAvatar || !envoiAvatarUrl || avatarError);

  // Determine rekey indicator
  const getRekeyIndicator = () => {
    if (
      !showRekeyIndicator ||
      !account ||
      account.type !== AccountType.REKEYED
    ) {
      return null;
    }

    const rekeyedAccount = account as RekeyedAccountMetadata;
    return {
      iconName: rekeyedAccount.canSign ? 'key' : 'lock-closed',
      color: rekeyedAccount.canSign ? '#10B981' : '#F59E0B', // Green if we can sign, amber if we can't
    };
  };

  const rekeyIndicator = getRekeyIndicator();

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <View
        style={[
          styles.avatar,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        {shouldShowEnvoiAvatar ? (
          <Image
            source={{ uri: envoiAvatarUrl! }}
            style={[
              styles.envoiAvatar,
              { width: size, height: size, borderRadius: size / 2 },
            ]}
            onError={handleAvatarError}
            resizeMode="cover"
          />
        ) : shouldShowGenerated ? (
          <>
            <Svg width={size} height={size} style={{ borderRadius: size / 2 }}>
              {/* Background gradient */}
              <Circle
                cx={size / 2}
                cy={size / 2}
                r={size / 2}
                fill={colors[0]}
              />

              {/* Geometric patterns */}
              {patterns}
            </Svg>

            {/* Fallback initials (hidden behind SVG normally) */}
            <View
              style={[
                styles.fallback,
                {
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                },
              ]}
            >
              <Text
                style={[
                  styles.initials,
                  { fontSize: size * 0.4, color: initialsColor },
                ]}
              >
                {initials}
              </Text>
            </View>
          </>
        ) : (
          <View
            style={[
              styles.placeholder,
              {
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: colors[0],
              },
            ]}
          >
            <Text
              style={[
                styles.initials,
                { fontSize: size * 0.4, color: initialsColor },
              ]}
            >
              {initials}
            </Text>
          </View>
        )}
      </View>

      {/* Active account indicator */}
      {showActiveIndicator && (
        <View
          style={[
            styles.activeIndicator,
            {
              width: size * 0.3,
              height: size * 0.3,
              borderRadius: size * 0.15,
              bottom: -2,
              right: -2,
            },
          ]}
        >
          <Text style={[styles.checkmark, { fontSize: size * 0.2 }]}>✓</Text>
        </View>
      )}

      {/* Rekey indicator */}
      {rekeyIndicator && (
        <View
          style={[
            styles.rekeyIndicator,
            {
              width: size * 0.35,
              height: size * 0.35,
              borderRadius: size * 0.175,
              top: -2,
              right: -2,
              backgroundColor: rekeyIndicator.color,
            },
          ]}
        >
          <Ionicons
            name={rekeyIndicator.iconName as any}
            size={size * 0.2}
            color="#FFFFFF"
          />
        </View>
      )}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      position: 'relative',
    },
    avatar: {
      position: 'relative',
      overflow: 'hidden',
    },
    fallback: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'transparent',
      pointerEvents: 'none',
    },
    initials: {
      fontWeight: '600',
      textAlign: 'center',
      textShadowColor: 'rgba(0, 0, 0, 0.35)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 2,
    },
    activeIndicator: {
      position: 'absolute',
      backgroundColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: theme.colors.card,
    },
    checkmark: {
      color: '#FFFFFF',
      fontWeight: 'bold',
    },
    rekeyIndicator: {
      position: 'absolute',
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: theme.colors.card,
      ...theme.shadows.sm,
    },
    envoiAvatar: {
      position: 'absolute',
      top: 0,
      left: 0,
    },
    placeholder: {
      position: 'absolute',
      top: 0,
      left: 0,
      justifyContent: 'center',
      alignItems: 'center',
    },
  });

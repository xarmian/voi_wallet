import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Alert,
  Image,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { formatAddress } from '@/utils/address';
import { EnvoiNameInfo } from '@/services/envoi';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import AccountAvatar from '@/components/account/AccountAvatar';
import { GlassCard } from '@/components/common/GlassCard';
import { useTheme } from '@/contexts/ThemeContext';

interface EnvoiProfileCardProps {
  address: string;
  name?: string;
  envoiProfile?: EnvoiNameInfo | null;
  isLoading?: boolean;
  title?: string;
  showVerifiedBadge?: boolean;
}

interface SocialLinkProps {
  platform: string;
  url: string;
}

// Clean username by removing spaces and invalid characters
const cleanUsername = (username: string): string => {
  return username.trim().replace(/[^a-zA-Z0-9._-]/g, '');
};

// Build social media URL from platform and username/ID
const buildSocialUrl = (platform: string, value: string): string => {
  const cleanedValue = cleanUsername(value);

  // If it's already a full URL, return as-is
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  // Handle different platform formats
  switch (platform.toLowerCase()) {
    case 'com.twitter':
    case 'twitter':
      return `https://x.com/${cleanedValue}`;
    case 'com.github':
    case 'github':
      return `https://github.com/${cleanedValue}`;
    case 'com.instagram':
    case 'instagram':
      return `https://instagram.com/${cleanedValue}`;
    case 'com.linkedin':
    case 'linkedin':
      return `https://linkedin.com/in/${cleanedValue}`;
    case 'com.telegram':
    case 'telegram':
      return `https://t.me/${cleanedValue}`;
    case 'com.youtube':
    case 'youtube':
      return `https://youtube.com/@${cleanedValue}`;
    case 'com.tiktok':
    case 'tiktok':
      return `https://tiktok.com/@${cleanedValue}`;
    case 'com.reddit':
    case 'reddit':
      return `https://reddit.com/u/${cleanedValue}`;
    case 'com.facebook':
    case 'facebook':
      return `https://facebook.com/${cleanedValue}`;
    case 'com.discord':
    case 'discord':
      // Discord handles are more complex, assume it's a username
      return `https://discord.com/users/${cleanedValue}`;
    case 'url':
    case 'website':
    case 'homepage':
      // For general URLs, add https if not present
      if (!value.startsWith('http')) {
        return `https://${value}`;
      }
      return value;
    default:
      // Return empty string for unsupported platforms
      return '';
  }
};

const SocialLinkButton: React.FC<SocialLinkProps> = ({ platform, url }) => {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const handlePress = () => {
    Linking.openURL(url).catch((err) => {
      console.error('Failed to open URL:', err);
    });
  };

  const getIcon = () => {
    const normalizedPlatform = platform.toLowerCase();

    if (
      normalizedPlatform.includes('twitter') ||
      normalizedPlatform.includes('x.com')
    ) {
      return 'logo-x'; // Use X logo instead of Twitter
    }
    if (normalizedPlatform.includes('discord')) {
      return 'logo-discord';
    }
    if (normalizedPlatform.includes('telegram')) {
      return 'send';
    }
    if (normalizedPlatform.includes('github')) {
      return 'logo-github';
    }
    if (normalizedPlatform.includes('linkedin')) {
      return 'logo-linkedin';
    }
    if (normalizedPlatform.includes('instagram')) {
      return 'logo-instagram';
    }
    if (normalizedPlatform.includes('youtube')) {
      return 'logo-youtube';
    }
    if (normalizedPlatform.includes('tiktok')) {
      return 'musical-notes';
    }
    if (normalizedPlatform.includes('reddit')) {
      return 'logo-reddit';
    }
    if (normalizedPlatform.includes('facebook')) {
      return 'logo-facebook';
    }
    if (
      normalizedPlatform.includes('url') ||
      normalizedPlatform.includes('website') ||
      normalizedPlatform.includes('web') ||
      normalizedPlatform.includes('homepage')
    ) {
      return 'globe';
    }

    // Default to link icon
    return 'link';
  };

  const getColor = () => {
    const normalizedPlatform = platform.toLowerCase();

    if (
      normalizedPlatform.includes('twitter') ||
      normalizedPlatform.includes('x.com')
    ) {
      return '#1DA1F2';
    }
    if (normalizedPlatform.includes('discord')) {
      return '#5865F2';
    }
    if (normalizedPlatform.includes('telegram')) {
      return '#0088CC';
    }
    if (normalizedPlatform.includes('github')) {
      return themeColors.text; // Use theme text color for better visibility
    }
    if (normalizedPlatform.includes('linkedin')) {
      return '#0A66C2';
    }
    if (normalizedPlatform.includes('instagram')) {
      return '#E4405F';
    }
    if (normalizedPlatform.includes('youtube')) {
      return '#FF0000';
    }
    if (normalizedPlatform.includes('reddit')) {
      return '#FF4500';
    }
    if (normalizedPlatform.includes('facebook')) {
      return '#1877F2';
    }

    return '#007AFF';
  };

  return (
    <TouchableOpacity
      style={[styles.socialButton, { borderColor: getColor() }]}
      onPress={handlePress}
    >
      <Ionicons name={getIcon() as any} size={18} color={getColor()} />
    </TouchableOpacity>
  );
};

export default function EnvoiProfileCard({
  address,
  name,
  envoiProfile,
  isLoading = false,
  title = 'Sending to',
  showVerifiedBadge = true,
}: EnvoiProfileCardProps) {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const { theme } = useTheme();
  const displayName = envoiProfile?.name || name;
  const bio = envoiProfile?.bio;
  const socialLinks = envoiProfile?.socialLinks;

  const renderBio = () => {
    if (!bio || bio.trim().length === 0) {
      return null;
    }

    return (
      <View style={styles.bioContainer}>
        <Text style={styles.bioText}>{bio}</Text>
      </View>
    );
  };

  const renderSocialLinks = () => {
    if (!socialLinks || Object.keys(socialLinks).length === 0) {
      return null;
    }

    // Filter out non-social metadata and build proper URLs
    const validLinks = Object.entries(socialLinks)
      .filter(([key, value]) => {
        // Skip avatar, bio, location, and other non-social metadata
        if (
          key === 'avatar' ||
          key === 'bio' ||
          key === 'location' ||
          !value ||
          typeof value !== 'string' ||
          value.trim().length === 0
        ) {
          return false;
        }
        return true;
      })
      .map(([platform, value]) => ({
        platform,
        url: buildSocialUrl(platform, value),
      }))
      .filter(({ url }) => url !== '') // Only keep known platforms with valid URLs
      .slice(0, 5); // Limit to 5 social links to avoid overflow

    if (validLinks.length === 0) {
      return null;
    }

    return (
      <View style={styles.socialLinksContainer}>
        <Text style={styles.socialLinksTitle}>Social Links</Text>
        <View style={styles.socialLinksRow}>
          {validLinks.map(({ platform, url }, index) => (
            <SocialLinkButton
              key={`${platform}-${index}`}
              platform={platform}
              url={url}
            />
          ))}
        </View>
      </View>
    );
  };

  const copyAddressToClipboard = async () => {
    try {
      await Clipboard.setStringAsync(address);
      Alert.alert('Copied', 'Address copied to clipboard');
    } catch (error) {
      console.error('Failed to copy address:', error);
      Alert.alert('Error', 'Failed to copy address');
    }
  };

  return (
    <GlassCard
      style={styles.container}
      variant="medium"
    >
      {title && <Text style={styles.title}>{title}</Text>}

      <View style={styles.profileContainer}>
        <View style={styles.avatarContainer}>
          {envoiProfile?.avatar ? (
            <Image
              source={{ uri: envoiProfile.avatar }}
              style={styles.avatarImage}
            />
          ) : (
            <AccountAvatar
              address={address}
              size={64}
              useEnvoiAvatar={true}
              fallbackToGenerated={true}
              showActiveIndicator={false}
              showRekeyIndicator={false}
            />
          )}
        </View>

        <View style={styles.profileInfo}>
          <Text style={styles.profileName}>
            {displayName || formatAddress(address)}
          </Text>

          <TouchableOpacity onPress={copyAddressToClipboard} style={styles.addressContainer}>
            <Text style={styles.profileAddress}>{formatAddress(address)}</Text>
            <Ionicons name="copy-outline" size={14} color={themeColors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      {renderBio()}

      {renderSocialLinks()}
    </GlassCard>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    title: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.sm,
    },
    profileContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    avatarContainer: {
      marginRight: theme.spacing.sm,
    },
    avatar: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.colors.glassBackground,
    },
    profileInfo: {
      flex: 1,
    },
    profileName: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    profileAddress: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      fontFamily: 'monospace',
      marginBottom: theme.spacing.xs,
    },
    verifiedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    verifiedText: {
      fontSize: 12,
      color: theme.colors.success,
      fontWeight: '500',
    },
    addressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    socialLinksContainer: {
      marginTop: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.glassBorder,
    },
    socialLinksTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.sm,
    },
    socialLinksRow: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    socialButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1.5,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.colors.glassBackground,
    },
    bioContainer: {
      marginTop: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.glassBorder,
    },
    bioText: {
      fontSize: 14,
      color: theme.colors.text,
      lineHeight: 20,
    },
    avatarImage: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.colors.glassBackground,
    },
  });

import React, { useCallback, useState } from 'react';
import {
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';

import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import EnvoiProfileCard from '@/components/envoi/EnvoiProfileCard';
import { useActiveAccount, useAccountEnvoiName } from '@/store/walletStore';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import { NFTBackground } from '@/components/common/NFTBackground';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassButton } from '@/components/common/GlassButton';

const ENVOI_WEBSITE = 'https://envoi.sh/';

export default function MyProfileScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const navigation = useNavigation();
  const activeAccount = useActiveAccount();
  const networkConfig = useCurrentNetworkConfig();

  const {
    nameInfo,
    reload: reloadEnvoiName,
  } = useAccountEnvoiName(activeAccount?.id || '');

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!activeAccount) {
      return;
    }

    setIsRefreshing(true);
    try {
      await reloadEnvoiName();
    } catch (error) {
      console.error('Failed to refresh envoi profile:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [activeAccount, reloadEnvoiName]);

  const handleCopyAddress = useCallback(async () => {
    if (!activeAccount?.address) {
      return;
    }

    try {
      await Clipboard.setStringAsync(activeAccount.address);
      Alert.alert('Copied', 'Address copied to clipboard');
    } catch (error) {
      console.error('Failed to copy address:', error);
      Alert.alert('Error', 'Failed to copy address');
    }
  }, [activeAccount?.address]);

  const handleOpenExplorer = useCallback(() => {
    if (!activeAccount?.address) {
      return;
    }

    const explorerUrl = networkConfig?.blockExplorerUrl;
    if (!explorerUrl) {
      Alert.alert('Unavailable', 'No explorer configured for this network.');
      return;
    }

    const url = `${explorerUrl.replace(/\/$/, '')}/account/${activeAccount.address}`;
    Linking.openURL(url).catch((error) => {
      console.error('Failed to open explorer:', error);
      Alert.alert('Error', 'Unable to open explorer link.');
    });
  }, [activeAccount?.address, networkConfig?.blockExplorerUrl]);

  const handleShareProfile = useCallback(async () => {
    if (!activeAccount) {
      return;
    }

    const message = nameInfo?.name
      ? `${nameInfo.name} on Voi\n${activeAccount.address}`
      : `${activeAccount.label || 'My Voi address'}\n${activeAccount.address}`;

    try {
      await Share.share({
        message,
        title: 'Share Profile',
      });
    } catch (error) {
      console.error('Failed to share profile:', error);
    }
  }, [activeAccount, nameInfo?.name]);

  const handleOpenEnvoi = useCallback(() => {
    Linking.openURL(ENVOI_WEBSITE).catch((error) => {
      console.error('Failed to open envoi website:', error);
    });
  }, []);

  if (!activeAccount) {
    return (
      <NFTBackground>
        <SafeAreaView style={styles.container} edges={['top']}>
          <UniversalHeader
            title="My Profile"
            showBackButton
            onBackPress={() => navigation.goBack()}
            showAccountSelector={false}
            onAccountSelectorPress={() => {}}
          />

          <View style={styles.emptyState}>
            <Ionicons name="wallet-outline" size={48} color={theme.colors.textMuted} />
            <Text style={styles.emptyTitle}>No active account</Text>
            <Text style={styles.emptySubtitle}>
              Add or select an account to view your profile.
            </Text>
          </View>
        </SafeAreaView>
      </NFTBackground>
    );
  }

  const hasEnvoiName = Boolean(nameInfo?.name);

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="My Profile"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
        >
          <EnvoiProfileCard
            address={activeAccount.address}
            envoiProfile={hasEnvoiName ? nameInfo : null}
            name={hasEnvoiName ? undefined : activeAccount.label || activeAccount.address}
            isLoading={false}
            title="My Profile"
            showVerifiedBadge={false}
          />

          {/* Quick Actions */}
          <BlurredContainer
            style={styles.card}
            borderRadius={theme.borderRadius.lg}
          >
            <Text style={styles.cardTitle}>Quick Actions</Text>
            <View style={styles.actionRow}>
              <GlassButton
                variant="secondary"
                size="sm"
                label="Explorer"
                icon="open-outline"
                onPress={handleOpenExplorer}
                style={styles.actionButton}
              />
              <GlassButton
                variant="secondary"
                size="sm"
                label="Copy"
                icon="copy"
                onPress={handleCopyAddress}
                style={styles.actionButton}
              />
              <GlassButton
                variant="secondary"
                size="sm"
                label="Share"
                icon="share-social"
                onPress={handleShareProfile}
                style={styles.actionButton}
              />
            </View>
          </BlurredContainer>

          {/* Envoi Identity */}
          <BlurredContainer
            style={styles.card}
            borderRadius={theme.borderRadius.lg}
          >
            <Text style={styles.cardTitle}>Envoi Identity</Text>
            {hasEnvoiName ? (
              <>
                <Text style={styles.identityLabel}>Envoi Name</Text>
                <Text style={styles.identityValue}>{nameInfo?.name}</Text>
                <Text style={styles.helperText}>
                  Your Envoi profile is how friends find you on Voi.
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.helperText}>
                  You have not linked an Envoi name to this account yet.
                </Text>
                <GlassButton
                  variant="primary"
                  size="md"
                  label="Register at envoi.sh"
                  onPress={handleOpenEnvoi}
                  style={{ marginTop: theme.spacing.sm }}
                />
              </>
            )}
          </BlurredContainer>

          {/* Wallet Address */}
          <BlurredContainer
            style={styles.card}
            borderRadius={theme.borderRadius.lg}
          >
            <Text style={styles.cardTitle}>Wallet Address</Text>
            <TouchableOpacity
              style={styles.addressContainer}
              onPress={handleCopyAddress}
            >
              <Text style={styles.address}>{activeAccount.address}</Text>
              <Ionicons name="copy" size={20} color={theme.colors.primary} />
            </TouchableOpacity>
          </BlurredContainer>
        </ScrollView>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
    card: {
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    actionRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
    },
    actionButton: {
      flex: 1,
    },
    identityLabel: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.xs,
    },
    identityValue: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    helperText: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    addressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: theme.spacing.sm,
      backgroundColor: theme.colors.glassBackground,
      borderRadius: theme.borderRadius.sm,
    },
    address: {
      flex: 1,
      marginRight: theme.spacing.sm,
      fontFamily: 'monospace',
      color: theme.colors.text,
      fontSize: 13,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.sm,
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
  });

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

const ENVOI_WEBSITE = 'https://envoi.sh/';

export default function MyProfileScreen() {
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation();
  const activeAccount = useActiveAccount();
  const networkConfig = useCurrentNetworkConfig();

  const {
    nameInfo,
    isLoading: isEnvoiLoading,
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
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => navigation.goBack()}
          >
            <Ionicons name="chevron-back" size={24} color={styles.headerText.color} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>My Profile</Text>
          <View style={styles.iconPlaceholder} />
        </View>

        <View style={styles.emptyState}>
          <Ionicons name="wallet-outline" size={48} color={styles.emptyIcon.color} />
          <Text style={styles.emptyTitle}>No active account</Text>
          <Text style={styles.emptySubtitle}>
            Add or select an account to view your profile.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const hasEnvoiName = Boolean(nameInfo?.name);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="chevron-back" size={24} color={styles.headerText.color} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Profile</Text>
        <View style={styles.iconPlaceholder} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing || isEnvoiLoading}
            onRefresh={handleRefresh}
          />
        }
      >
        <EnvoiProfileCard
          address={activeAccount.address}
          envoiProfile={hasEnvoiName ? nameInfo : null}
          name={hasEnvoiName ? undefined : activeAccount.label || activeAccount.address}
          isLoading={isEnvoiLoading}
          title="My Profile"
          showVerifiedBadge={false}
        />

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Quick Actions</Text>
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionButton} onPress={handleOpenExplorer}>
              <Ionicons name="open-outline" size={20} color={styles.actionIcon.color} />
              <Text style={styles.actionLabel}>Explorer</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={handleCopyAddress}>
              <Ionicons name="copy" size={20} color={styles.actionIcon.color} />
              <Text style={styles.actionLabel}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={handleShareProfile}>
              <Ionicons name="share-social" size={20} color={styles.actionIcon.color} />
              <Text style={styles.actionLabel}>Share</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
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
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleOpenEnvoi}
              >
                <Text style={styles.primaryButtonText}>Register at envoi.sh</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Wallet Address</Text>
          <TouchableOpacity
            style={styles.addressContainer}
            onPress={handleCopyAddress}
          >
            <Text style={styles.address}>{activeAccount.address}</Text>
            <Ionicons name="copy" size={20} color={styles.actionIcon.color} />
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.md,
      paddingBottom: theme.spacing.xxl,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
      textAlign: 'center',
    },
    headerText: {
      color: theme.colors.text,
    },
    iconButton: {
      padding: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
    },
    iconPlaceholder: {
      width: 32,
    },
    card: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.md,
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
      marginTop: theme.spacing.sm,
    },
    actionButton: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface,
      marginHorizontal: theme.spacing.xs,
    },
    actionLabel: {
      marginTop: 4,
      fontSize: 14,
      color: theme.colors.text,
    },
    actionIcon: {
      color: theme.colors.primary,
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
    primaryButton: {
      marginTop: theme.spacing.sm,
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.md,
      paddingVertical: theme.spacing.sm,
      alignItems: 'center',
    },
    primaryButtonText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
    addressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
    },
    address: {
      flex: 1,
      marginRight: theme.spacing.sm,
      fontFamily: 'monospace',
      color: theme.colors.text,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
    },
    emptyIcon: {
      color: theme.colors.textMuted,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
  });

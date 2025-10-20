import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';

import { SettingsStackParamList } from '@/navigation/AppNavigator';
import {
  WalletConnectService,
  WalletConnectSession,
} from '@/services/walletconnect';
import UniversalHeader from '@/components/common/UniversalHeader';
import {
  formatSessionExpiry,
  truncateAddress,
} from '@/services/walletconnect/utils';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type SessionsScreenNavigationProp = StackNavigationProp<
  SettingsStackParamList,
  'WalletConnectSessions'
>;

interface Props {
  navigation: SessionsScreenNavigationProp;
}

export default function SessionsScreen({ navigation }: Props) {
  const [sessions, setSessions] = useState<WalletConnectSession[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const wcService = WalletConnectService.getInstance();
      const activeSessions = wcService.getActiveSessions();
      setSessions(activeSessions);
    } catch (error) {
      console.error('Failed to load sessions:', error);
      Alert.alert('Error', 'Failed to load WalletConnect sessions');
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadSessions();
    setIsRefreshing(false);
  }, [loadSessions]);

  const handleDisconnect = useCallback(
    async (session: WalletConnectSession) => {
      Alert.alert(
        'Disconnect Session',
        `Are you sure you want to disconnect from ${session.peerMetadata?.name || 'Unknown dApp'}?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disconnect',
            style: 'destructive',
            onPress: async () => {
              try {
                const wcService = WalletConnectService.getInstance();
                await wcService.disconnectSession(session.topic);
                await loadSessions();
                Alert.alert('Success', 'Session disconnected successfully');
              } catch (error) {
                console.error('Failed to disconnect session:', error);
                Alert.alert(
                  'Error',
                  error instanceof Error
                    ? error.message
                    : 'Failed to disconnect session'
                );
              }
            },
          },
        ]
      );
    },
    [loadSessions]
  );

  const renderSessionItem = (session: WalletConnectSession) => {
    const accounts = session.namespaces?.algorand?.accounts || [];
    const peer = session.peerMetadata || session.peer?.metadata || ({} as any);
    const peerIcons = peer?.icons || [];
    const peerName = peer?.name || 'Unknown dApp';
    const peerUrl = peer?.url || '';
    const peerDescription = peer?.description || '';

    return (
      <View key={session.topic} style={styles.sessionItem}>
        <View style={styles.sessionHeader}>
          {peerIcons.length > 0 && (
            <Image
              source={{ uri: peerIcons[0] }}
              style={styles.dappIcon}
              defaultSource={require('../../../assets/icon.png')}
            />
          )}
          <View style={styles.sessionInfo}>
            <Text style={styles.dappName}>{peerName}</Text>
            {!!peerUrl && <Text style={styles.dappUrl}>{peerUrl}</Text>}
          </View>
          <TouchableOpacity
            style={styles.disconnectButton}
            onPress={() => handleDisconnect(session)}
          >
            <Ionicons
              name="close-circle"
              size={24}
              color={theme.colors.error}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.sessionDetails}>
          <View style={styles.detailRow}>
            <Ionicons name="time" size={16} color={theme.colors.textMuted} />
            <Text style={styles.detailText}>
              Expires: {formatSessionExpiry(session.expiry)}
            </Text>
          </View>

          <View style={styles.detailRow}>
            <Ionicons name="wallet" size={16} color={theme.colors.textMuted} />
            <Text style={styles.detailText}>Accounts: {accounts.length}</Text>
          </View>

          {accounts.length > 0 && (
            <View style={styles.accountsList}>
              {accounts.slice(0, 3).map((account) => {
                // Extract address from formatted account string
                const address = account.split(':').pop() || '';
                return (
                  <Text key={account} style={styles.accountAddress}>
                    {truncateAddress(address)}
                  </Text>
                );
              })}
              {accounts.length > 3 && (
                <Text style={styles.moreAccounts}>
                  +{accounts.length - 3} more
                </Text>
              )}
            </View>
          )}
        </View>

        {!!peerDescription && (
          <Text style={styles.dappDescription} numberOfLines={2}>
            {peerDescription}
          </Text>
        )}
      </View>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <Ionicons name="link" size={64} color={theme.colors.textMuted} />
      <Text style={styles.emptyTitle}>No Connected dApps</Text>
      <Text style={styles.emptyDescription}>
        Connect to dApps by scanning QR codes or clicking connection links
      </Text>
      <TouchableOpacity
        style={styles.connectButton}
        onPress={() => navigation.navigate('Home' as never)}
      >
        <Ionicons name="qr-code" size={20} color={theme.colors.buttonText} />
        <Text style={styles.connectButtonText}>Scan QR Code</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title="WalletConnect Sessions"
        showBackButton
        onBackPress={() => navigation.goBack()}
      />

      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
      >
        {sessions.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>
              Active Connections ({sessions.length})
            </Text>
            {sessions.map(renderSessionItem)}
          </>
        ) : (
          renderEmptyState()
        )}
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
      padding: 16,
    },
    sectionTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 16,
    },
    sessionItem: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      ...theme.shadows.small,
    },
    sessionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
    },
    dappIcon: {
      width: 40,
      height: 40,
      borderRadius: 8,
      marginRight: 12,
    },
    sessionInfo: {
      flex: 1,
    },
    dappName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    dappUrl: {
      fontSize: 12,
      color: theme.colors.primary,
    },
    disconnectButton: {
      padding: 4,
    },
    sessionDetails: {
      marginBottom: 8,
    },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 6,
    },
    detailText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginLeft: 8,
    },
    accountsList: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 4,
      marginLeft: 24,
    },
    accountAddress: {
      fontSize: 11,
      color: theme.colors.primary,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 4,
      marginRight: 6,
      marginBottom: 4,
    },
    moreAccounts: {
      fontSize: 11,
      color: theme.colors.textMuted,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    dappDescription: {
      fontSize: 12,
      color: theme.colors.textMuted,
      lineHeight: 16,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 60,
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: 16,
      marginBottom: 8,
    },
    emptyDescription: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 24,
      paddingHorizontal: 32,
    },
    connectButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 8,
    },
    connectButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
      marginLeft: 8,
    },
  });

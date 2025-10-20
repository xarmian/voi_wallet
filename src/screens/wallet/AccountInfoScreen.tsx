import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Dimensions,
  TouchableOpacity,
  Alert,
  Linking,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RouteProp, useRoute } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { PieChart } from 'react-native-chart-kit';
import { WalletStackParamList } from '@/navigation/AppNavigator';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  useActiveAccount,
  useAccountEnvoiName,
  useMultiNetworkBalance,
  useWalletStore,
} from '@/store/walletStore';
import { formatCurrency } from '@/utils/formatting';
import EnvoiProfileCard from '@/components/envoi/EnvoiProfileCard';
import { NetworkService } from '@/services/network';
import { MimirApiService } from '@/services/mimir';
import { NetworkId } from '@/types/network';
import { MappedAsset } from '@/services/token-mapping/types';

type AccountInfoScreenRouteProp = RouteProp<WalletStackParamList, 'AccountInfo'>;

interface AssetDistribution {
  name: string;
  population: number;
  color: string;
  legendFontColor: string;
  legendFontSize: number;
  networkBadge?: string; // Optional network indicator for unmapped assets
}

interface NetworkStats {
  networkId: NetworkId;
  nativeBalance: bigint;
  assetCount: number;
  usdValue: number;
  nativeSymbol: string;
}

const screenWidth = Dimensions.get('window').width;

export default function AccountInfoScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [voiAccountInfo, setVoiAccountInfo] = useState<any>(null);
  const [algoAccountInfo, setAlgoAccountInfo] = useState<any>(null);
  const [isLoadingAccountInfo, setIsLoadingAccountInfo] = useState(true);
  const [accountAge, setAccountAge] = useState<string>('Loading...');
  const route = useRoute<AccountInfoScreenRouteProp>();
  const navigation = useNavigation();
  const styles = useThemedStyles(createStyles);

  const activeAccount = useActiveAccount();
  const {
    balance: multiNetworkBalance,
    isLoading: isMultiNetworkBalanceLoading,
  } = useMultiNetworkBalance(activeAccount?.id || '');
  const {
    nameInfo: envoiNameInfo,
    isLoading: isEnvoiLoading,
    reload: reloadEnvoiName,
  } = useAccountEnvoiName(activeAccount?.id || '');

  const loadMultiNetworkBalance = useWalletStore(
    (state) => state.loadMultiNetworkBalance
  );

  const calculateAndSetAccountAge = useCallback(async (address: string) => {
    try {
      // Get account creation round from MimirAPI
      const mimirService = MimirApiService.getInstance();
      const accountData = await mimirService.getAccountInfo(address);

      if (!accountData?.account?.created_round) {
        setAccountAge('Unable to determine');
        return;
      }

      const createdRound = accountData.account.created_round;

      // Convert round to approximate date (2.8 seconds per round)
      const SECONDS_PER_ROUND = 2.8;
      const VOI_GENESIS_DATE = new Date('2024-03-01'); // Approximate Voi network start

      const secondsSinceGenesis = createdRound * SECONDS_PER_ROUND;
      const createdDate = new Date(VOI_GENESIS_DATE.getTime() + (secondsSinceGenesis * 1000));
      const now = new Date();
      const diffMs = now.getTime() - createdDate.getTime();
      const daysSinceCreation = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (daysSinceCreation < 30) {
        setAccountAge(`${daysSinceCreation} days`);
      } else if (daysSinceCreation < 365) {
        const months = Math.floor(daysSinceCreation / 30);
        const remainingDays = daysSinceCreation % 30;
        setAccountAge(remainingDays > 0 ? `${months} months ${remainingDays} days` : `${months} months`);
      } else {
        const years = Math.floor(daysSinceCreation / 365);
        const remainingDays = daysSinceCreation % 365;
        if (remainingDays < 30) {
          setAccountAge(remainingDays > 0 ? `${years} year${years > 1 ? 's' : ''} ${remainingDays} days` : `${years} year${years > 1 ? 's' : ''}`);
        } else {
          const months = Math.floor(remainingDays / 30);
          const days = remainingDays % 30;
          setAccountAge(days > 0
            ? `${years} year${years > 1 ? 's' : ''} ${months} month${months > 1 ? 's' : ''} ${days} days`
            : `${years} year${years > 1 ? 's' : ''} ${months} month${months > 1 ? 's' : ''}`);
        }
      }
    } catch (error) {
      console.error('Failed to calculate account age:', error);
      setAccountAge('Unable to determine');
    }
  }, []);

  const loadAccountInfo = useCallback(async () => {
    if (!activeAccount) return;

    setIsLoadingAccountInfo(true);

    // Load account info from both networks
    const loadVoi = async () => {
      try {
        const voiService = NetworkService.getInstance(NetworkId.VOI_MAINNET);
        const info = await voiService.getAccountInfo(activeAccount.address);
        setVoiAccountInfo(info);
      } catch (error) {
        console.error('Failed to load Voi account info:', error);
        if (error instanceof Error && error.message && error.message.includes('account does not exist')) {
          setVoiAccountInfo({
            address: activeAccount.address,
            amount: 0,
            status: 'Offline',
            round: null
          });
        }
      }
    };

    const loadAlgo = async () => {
      try {
        const algoService = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
        const info = await algoService.getAccountInfo(activeAccount.address);
        setAlgoAccountInfo(info);
      } catch (error) {
        console.error('Failed to load Algorand account info:', error);
        if (error instanceof Error && error.message && error.message.includes('account does not exist')) {
          setAlgoAccountInfo({
            address: activeAccount.address,
            amount: 0,
            status: 'Offline',
            round: null
          });
        }
      }
    };

    await Promise.allSettled([loadVoi(), loadAlgo()]);
    setIsLoadingAccountInfo(false);
  }, [activeAccount]);

  // Calculate total USD value for a mapped asset
  const calculateAssetValue = useCallback((asset: MappedAsset): number => {
    let totalValue = 0;

    for (const source of asset.sourceBalances) {
      const sourceAsset = source.balance;
      if (sourceAsset.usdValue && sourceAsset.amount) {
        const unitPrice = parseFloat(sourceAsset.usdValue);
        const amount =
          typeof sourceAsset.amount === 'bigint'
            ? Number(sourceAsset.amount)
            : sourceAsset.amount;
        const normalizedBalance = amount / 10 ** sourceAsset.decimals;
        totalValue += normalizedBalance * unitPrice;
      }
    }

    return totalValue;
  }, []);

  const generateAssetDistribution = useCallback((): AssetDistribution[] => {
    if (!multiNetworkBalance) return [];

    const data: AssetDistribution[] = [];
    const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#FF6384', '#C9CBCF'];
    let colorIndex = 0;

    // Add assets from multi-network balance
    if (multiNetworkBalance.assets) {
      multiNetworkBalance.assets.forEach((asset) => {
        const assetValue = calculateAssetValue(asset);

        if (assetValue >= 0.01) { // Filter dust
          const networkBadge = !asset.isMapped && asset.sourceBalances.length === 1
            ? asset.sourceBalances[0].networkId === NetworkId.VOI_MAINNET ? 'VOI' : 'ALGO'
            : undefined;

          data.push({
            name: asset.symbol || asset.name || `Asset ${asset.assetId}`,
            population: Math.round(assetValue * 100) / 100,
            color: colors[colorIndex % colors.length],
            legendFontColor: styles.chartText.color,
            legendFontSize: 12,
            networkBadge,
          });
          colorIndex++;
        }
      });
    }

    return data;
  }, [multiNetworkBalance, calculateAssetValue, styles.chartText.color]);

  const getTotalUsdValue = useCallback((): string => {
    if (!multiNetworkBalance) return formatCurrency(0);

    let totalUsdValue = 0;

    // Add all asset values (includes native tokens)
    if (multiNetworkBalance.assets) {
      multiNetworkBalance.assets.forEach((asset) => {
        totalUsdValue += calculateAssetValue(asset);
      });
    }

    return formatCurrency(totalUsdValue);
  }, [multiNetworkBalance, calculateAssetValue]);

  const getNetworkBreakdown = useCallback((): NetworkStats[] => {
    if (!multiNetworkBalance) return [];

    const stats: NetworkStats[] = [];

    // Voi Network
    const voiAmount = multiNetworkBalance.perNetworkAmounts[NetworkId.VOI_MAINNET];
    const voiPrice = multiNetworkBalance.perNetworkPrices[NetworkId.VOI_MAINNET];
    if (voiAmount !== undefined) {
      // Calculate value ONLY from balances on this specific network
      let voiValue = 0;
      let voiAssetCount = 0;

      multiNetworkBalance.assets.forEach((asset) => {
        const voiSource = asset.sourceBalances.find((s) => s.networkId === NetworkId.VOI_MAINNET);
        if (voiSource) {
          voiAssetCount++;
          const sourceAsset = voiSource.balance;
          if (sourceAsset.usdValue && sourceAsset.amount) {
            const unitPrice = parseFloat(sourceAsset.usdValue);
            const amount = typeof sourceAsset.amount === 'bigint' ? Number(sourceAsset.amount) : sourceAsset.amount;
            const normalizedBalance = amount / 10 ** sourceAsset.decimals;
            voiValue += normalizedBalance * unitPrice;
          }
        }
      });

      stats.push({
        networkId: NetworkId.VOI_MAINNET,
        nativeBalance: voiAmount,
        assetCount: voiAssetCount,
        usdValue: voiValue,
        nativeSymbol: 'VOI',
      });
    }

    // Algorand Network
    const algoAmount = multiNetworkBalance.perNetworkAmounts[NetworkId.ALGORAND_MAINNET];
    const algoPrice = multiNetworkBalance.perNetworkPrices[NetworkId.ALGORAND_MAINNET];
    if (algoAmount !== undefined) {
      // Calculate value ONLY from balances on this specific network
      let algoValue = 0;
      let algoAssetCount = 0;

      multiNetworkBalance.assets.forEach((asset) => {
        const algoSource = asset.sourceBalances.find((s) => s.networkId === NetworkId.ALGORAND_MAINNET);
        if (algoSource) {
          algoAssetCount++;
          const sourceAsset = algoSource.balance;
          if (sourceAsset.usdValue && sourceAsset.amount) {
            const unitPrice = parseFloat(sourceAsset.usdValue);
            const amount = typeof sourceAsset.amount === 'bigint' ? Number(sourceAsset.amount) : sourceAsset.amount;
            const normalizedBalance = amount / 10 ** sourceAsset.decimals;
            algoValue += normalizedBalance * unitPrice;
          }
        }
      });

      stats.push({
        networkId: NetworkId.ALGORAND_MAINNET,
        nativeBalance: algoAmount,
        assetCount: algoAssetCount,
        usdValue: algoValue,
        nativeSymbol: 'ALGO',
      });
    }

    return stats;
  }, [multiNetworkBalance]);

  const copyAddressToClipboard = async () => {
    if (activeAccount) {
      try {
        await Clipboard.setStringAsync(activeAccount.address);
        Alert.alert('Copied', 'Address copied to clipboard');
      } catch (error) {
        console.error('Failed to copy address:', error);
        Alert.alert('Error', 'Failed to copy address');
      }
    }
  };

  const getConsensusStatus = (accountInfo: any) => {
    if (!accountInfo) return 'Unknown';
    return accountInfo.status === 'Online' ? 'Online (Participating)' : 'Offline';
  };

  const getKeyExpirationInfo = (accountInfo: any) => {
    // Check both camelCase and kebab-case versions
    const participation = accountInfo?.participation;
    if (!participation || !accountInfo?.round) {
      return null;
    }

    const lastValidRound = participation.voteLastValid || participation['vote-last-valid'];
    if (!lastValidRound) {
      return null;
    }

    const lastValidRoundNumber = Number(lastValidRound); // Convert BigInt to number
    const currentRoundNumber = Number(accountInfo.round); // Convert BigInt to number

    // Calculate seconds from now until expiration
    const SECONDS_PER_ROUND = 2.8;
    const roundsUntilExpiration = lastValidRoundNumber - currentRoundNumber;
    const secondsUntilExpiration = roundsUntilExpiration * SECONDS_PER_ROUND;

    // Calculate expiration date from now
    const now = new Date();
    const expirationDate = new Date(now.getTime() + (secondsUntilExpiration * 1000));

    const result = {
      round: lastValidRoundNumber,
      date: expirationDate.toLocaleDateString(),
      time: expirationDate.toLocaleTimeString(),
      secondsUntilExpiration: Math.floor(secondsUntilExpiration),
    };

    return result;
  };

  const onRefresh = async () => {
    if (!activeAccount) return;

    setRefreshing(true);
    await Promise.allSettled([
      loadMultiNetworkBalance(activeAccount.id, true),
      reloadEnvoiName(),
      loadAccountInfo(),
    ]);
    setRefreshing(false);
  };

  useEffect(() => {
    if (activeAccount) {
      reloadEnvoiName();
      loadAccountInfo();
      calculateAndSetAccountAge(activeAccount.address);
      loadMultiNetworkBalance(activeAccount.id);
    }
  }, [activeAccount, loadAccountInfo, calculateAndSetAccountAge, reloadEnvoiName, loadMultiNetworkBalance]);

  const assetDistribution = generateAssetDistribution();
  const totalValue = getTotalUsdValue();
  const networkStats = getNetworkBreakdown();
  const assetCount = multiNetworkBalance?.assets ? multiNetworkBalance.assets.length : 0;
  const networksActive = multiNetworkBalance?.sourceNetworks.length || 0;
  const totalMinBalance = multiNetworkBalance?.minBalance || 0n;

  if (!activeAccount) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-back" size={24} color={styles.headerText.color} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Account Information</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.loadingContainer}>
          <Text style={styles.errorText}>No active account found</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={24} color={styles.headerText.color} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Account Information</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Account Profile */}
        <EnvoiProfileCard
          address={activeAccount.address}
          envoiProfile={envoiNameInfo}
          isLoading={isEnvoiLoading}
          title="Account Information"
          showVerifiedBadge={false}
        />

        {/* Account Stats */}
        <View style={styles.statsContainer}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Total Portfolio</Text>
            {isMultiNetworkBalanceLoading ? (
              <ActivityIndicator size="small" color="#007AFF" />
            ) : (
              <Text style={styles.statValue}>{totalValue}</Text>
            )}
          </View>

          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Total Assets</Text>
            <Text style={styles.statValue}>{assetCount}</Text>
          </View>

          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Networks Active</Text>
            <Text style={styles.statValue}>{networksActive}</Text>
          </View>

          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Account Age</Text>
            <Text style={styles.statValue}>{accountAge}</Text>
          </View>
        </View>

        {/* Network Breakdown */}
        {networkStats.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Network Breakdown</Text>
            {networkStats.map((network) => (
              <View key={network.networkId} style={styles.networkRow}>
                <View style={styles.networkHeader}>
                  <View style={styles.networkBadge}>
                    <Text style={styles.networkBadgeText}>{network.nativeSymbol}</Text>
                  </View>
                  <Text style={styles.networkName}>
                    {network.networkId === NetworkId.VOI_MAINNET ? 'Voi Network' : 'Algorand Network'}
                  </Text>
                </View>
                <View style={styles.networkStats}>
                  <View style={styles.networkStatItem}>
                    <Text style={styles.networkStatLabel}>Balance</Text>
                    <Text style={styles.networkStatValue}>
                      {(Number(network.nativeBalance) / 1_000_000).toFixed(2)} {network.nativeSymbol}
                    </Text>
                  </View>
                  <View style={styles.networkStatItem}>
                    <Text style={styles.networkStatLabel}>Assets</Text>
                    <Text style={styles.networkStatValue}>{network.assetCount}</Text>
                  </View>
                  <View style={styles.networkStatItem}>
                    <Text style={styles.networkStatLabel}>Value</Text>
                    <Text style={styles.networkStatValue}>{formatCurrency(network.usdValue)}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Consensus Participation Status - Network Specific */}
        {(voiAccountInfo || algoAccountInfo) && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Consensus Participation</Text>

            {/* Voi Network Participation */}
            {voiAccountInfo && (
              <View style={styles.networkParticipationSection}>
                <View style={styles.networkHeader}>
                  <View style={styles.networkBadge}>
                    <Text style={styles.networkBadgeText}>VOI</Text>
                  </View>
                  <Text style={styles.networkName}>Voi Network</Text>
                </View>
                <Text style={styles.consensusStatus}>
                  Status: {getConsensusStatus(voiAccountInfo)}
                </Text>
                {(() => {
                  const keyExpiration = getKeyExpirationInfo(voiAccountInfo);
                  return keyExpiration && (
                    <View style={styles.participationDetails}>
                      <Text style={styles.participationText}>
                        Key Expires: Round {keyExpiration.round}
                      </Text>
                      <Text style={styles.participationText}>
                        Expiration: {keyExpiration.date} at {keyExpiration.time}
                      </Text>
                      {keyExpiration.secondsUntilExpiration > 0 && (
                        <Text style={styles.participationText}>
                          Time Remaining: {Math.floor(keyExpiration.secondsUntilExpiration / 86400)} days, {Math.floor((keyExpiration.secondsUntilExpiration % 86400) / 3600)} hours
                        </Text>
                      )}
                    </View>
                  );
                })()}
              </View>
            )}

            {/* Algorand Network Participation */}
            {algoAccountInfo && (
              <View style={styles.networkParticipationSection}>
                <View style={styles.networkHeader}>
                  <View style={styles.networkBadge}>
                    <Text style={styles.networkBadgeText}>ALGO</Text>
                  </View>
                  <Text style={styles.networkName}>Algorand Network</Text>
                </View>
                <Text style={styles.consensusStatus}>
                  Status: {getConsensusStatus(algoAccountInfo)}
                </Text>
                {(() => {
                  const keyExpiration = getKeyExpirationInfo(algoAccountInfo);
                  return keyExpiration && (
                    <View style={styles.participationDetails}>
                      <Text style={styles.participationText}>
                        Key Expires: Round {keyExpiration.round}
                      </Text>
                      <Text style={styles.participationText}>
                        Expiration: {keyExpiration.date} at {keyExpiration.time}
                      </Text>
                      {keyExpiration.secondsUntilExpiration > 0 && (
                        <Text style={styles.participationText}>
                          Time Remaining: {Math.floor(keyExpiration.secondsUntilExpiration / 86400)} days, {Math.floor((keyExpiration.secondsUntilExpiration % 86400) / 3600)} hours
                        </Text>
                      )}
                    </View>
                  );
                })()}
              </View>
            )}
          </View>
        )}


        {/* Asset Distribution Chart */}
        {assetDistribution.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Asset Distribution</Text>
            <View style={styles.chartContainer}>
              <PieChart
                data={assetDistribution}
                width={screenWidth - 60}
                height={220}
                chartConfig={{
                  backgroundColor: 'transparent',
                  backgroundGradientFrom: 'transparent',
                  backgroundGradientTo: 'transparent',
                  color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
                  labelColor: (opacity = 1) => styles.chartText.color,
                }}
                accessor="population"
                backgroundColor="transparent"
                paddingLeft="15"
                absolute
              />
            </View>
          </View>
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
    },
    content: {
      padding: theme.spacing.md,
      paddingBottom: theme.spacing.xxl,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    errorText: {
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    headerCard: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.md,
    },
    accountHeader: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    accountDetails: {
      marginLeft: theme.spacing.md,
      flex: 1,
    },
    accountName: {
      fontSize: 22,
      fontWeight: 'bold',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    accountAddress: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 4,
    },
    accountType: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    loadingText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.sm,
    },
    statsContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      marginBottom: theme.spacing.md,
    },
    statCard: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      width: '48%',
      marginBottom: theme.spacing.sm,
      alignItems: 'center',
    },
    statLabel: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginBottom: 4,
      textAlign: 'center',
    },
    statValue: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    card: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.md,
    },
    cardTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    consensusStatus: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    participationDetails: {
      marginTop: theme.spacing.sm,
    },
    participationText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginBottom: 4,
    },
    minBalanceText: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    minBalanceDescription: {
      fontSize: 14,
      color: theme.colors.textMuted,
      lineHeight: 20,
    },
    chartContainer: {
      alignItems: 'center',
      marginTop: theme.spacing.sm,
    },
    chartText: {
      color: theme.colors.text,
    },
    addressContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: theme.spacing.sm,
      backgroundColor: theme.colors.background,
      borderRadius: theme.borderRadius.md,
      marginBottom: theme.spacing.sm,
    },
    fullAddress: {
      fontSize: 12,
      color: theme.colors.text,
      fontFamily: 'monospace',
      lineHeight: 18,
      flex: 1,
    },
    copyIcon: {
      color: theme.colors.primary,
      marginLeft: theme.spacing.sm,
    },
    copyHint: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    socialLinks: {
      marginTop: theme.spacing.xs,
    },
    socialLinkItem: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    socialLinkText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.xs,
    },
    socialIcon: {
      color: theme.colors.textMuted,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    backButton: {
      padding: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
      textAlign: 'center',
    },
    headerSpacer: {
      width: 32, // Same width as back button for centering
    },
    headerText: {
      color: theme.colors.text,
    },
    networkRow: {
      marginBottom: theme.spacing.md,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    networkHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    networkBadge: {
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.sm,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      marginRight: theme.spacing.sm,
    },
    networkBadgeText: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: '600',
    },
    networkName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    networkStats: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: theme.spacing.xs,
    },
    networkStatItem: {
      flex: 1,
    },
    networkStatLabel: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginBottom: 2,
    },
    networkStatValue: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
    },
    networkParticipationSection: {
      marginBottom: theme.spacing.md,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
  });
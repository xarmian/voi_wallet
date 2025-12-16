import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import UniversalHeader from '@/components/common/UniversalHeader';
import { formatAddress } from '@/utils/address';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { NetworkService } from '@/services/network';
import { decodeBase64Url } from '@/utils/arc0090Uri';
import { RootStackParamList } from '@/navigation/AppNavigator';

type AppInfoModalRouteProp = RouteProp<RootStackParamList, 'AppInfoModal'>;
type AppInfoModalNavigationProp = StackNavigationProp<
  RootStackParamList,
  'AppInfoModal'
>;

interface AppInfoParams {
  appId: number;
  networkId?: NetworkId;
  queryParams?: {
    box?: string;
    global?: string;
    local?: string;
    algorandaddress?: string;
    tealcode?: boolean;
  };
}

interface AppInfo {
  id: number;
  creator: string;
  approvalProgram?: string;
  clearStateProgram?: string;
  globalState?: Record<string, any>;
  localState?: Record<string, any>;
  globalStateSchema?: {
    numUint: number;
    numByteSlice: number;
  };
  localStateSchema?: {
    numUint: number;
    numByteSlice: number;
  };
}

export default function AppInfoModal() {
  const navigation = useNavigation<AppInfoModalNavigationProp>();
  const route = useRoute<AppInfoModalRouteProp>();
  const params = route.params as AppInfoParams;
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [boxValue, setBoxValue] = useState<string | null>(null);
  const [globalValue, setGlobalValue] = useState<any>(null);
  const [localValue, setLocalValue] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const networkId = params.networkId || NetworkId.VOI_MAINNET;
  const networkConfig = getNetworkConfig(networkId);

  useEffect(() => {
    loadAppInfo();
  }, [params.appId, networkId]);

  const loadAppInfo = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const networkService = NetworkService.getInstance(networkId);
      const indexer = networkService.getIndexerClient();

      // Fetch app info
      const appResponse = await indexer.lookupApplications(params.appId).do();
      const app = appResponse.application;

      if (!app) {
        throw new Error(`Application ${params.appId} not found`);
      }

      const info: AppInfo = {
        id: Number(app.id),
        creator: String(app.params.creator),
        globalStateSchema: app.params.globalStateSchema,
        localStateSchema: app.params.localStateSchema,
      };

      // Parse global state
      if (app.params.globalState) {
        info.globalState = {};
        for (const item of app.params.globalState) {
          // item.key is Uint8Array from indexer, convert to string
          const key = new TextDecoder().decode(item.key as Uint8Array);
          if (item.value.type === 1) {
            // bytes - item.value.bytes is Uint8Array
            info.globalState[key] = new TextDecoder().decode(
              item.value.bytes as Uint8Array
            );
          } else {
            // uint
            info.globalState[key] = item.value.uint;
          }
        }
      }

      setAppInfo(info);

      // Handle query params
      if (params.queryParams?.box) {
        await loadBoxValue(params.queryParams.box);
      }

      if (params.queryParams?.global) {
        await loadGlobalValue(params.queryParams.global);
      }

      if (
        params.queryParams?.local &&
        params.queryParams?.algorandaddress
      ) {
        await loadLocalValue(
          params.queryParams.local,
          params.queryParams.algorandaddress
        );
      }
    } catch (err) {
      console.error('Failed to load app info:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to load application info'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const loadBoxValue = async (boxKey: string) => {
    try {
      const networkService = NetworkService.getInstance(networkId);
      const algod = networkService.getAlgodClient();

      // Decode the box key from base64url
      const keyBytes = decodeBase64Url(boxKey);

      // Fetch box value
      const boxResponse = await algod
        .getApplicationBoxByName(params.appId, keyBytes)
        .do();

      // Decode the box value
      const valueStr = Buffer.from(boxResponse.value).toString('utf-8');
      setBoxValue(valueStr);
    } catch (err) {
      console.error('Failed to load box value:', err);
      setBoxValue(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  };

  const loadGlobalValue = async (globalKey: string) => {
    try {
      // Global value is already loaded with app info
      if (appInfo?.globalState) {
        const keyStr = Buffer.from(decodeBase64Url(globalKey)).toString();
        setGlobalValue(appInfo.globalState[keyStr] ?? 'Not found');
      }
    } catch (err) {
      console.error('Failed to load global value:', err);
      setGlobalValue(
        `Error: ${err instanceof Error ? err.message : 'Unknown'}`
      );
    }
  };

  const loadLocalValue = async (localKey: string, address: string) => {
    try {
      const networkService = NetworkService.getInstance(networkId);
      const indexer = networkService.getIndexerClient();

      // Fetch account's local state for this app
      const accountResponse = await indexer.lookupAccountByID(address).do();
      const appsLocalState = accountResponse.account.appsLocalState || [];

      const appLocalState = appsLocalState.find(
        (als: any) => als.id === params.appId
      );

      if (!appLocalState) {
        setLocalValue('Account has not opted into this app');
        return;
      }

      const keyStr = Buffer.from(decodeBase64Url(localKey)).toString();
      const keyValue = appLocalState.keyValue?.find(
        (kv: any) => Buffer.from(kv.key, 'base64').toString() === keyStr
      );

      if (!keyValue) {
        setLocalValue('Key not found in local state');
        return;
      }

      if (keyValue.value.type === 1) {
        // bytes - value is Uint8Array from indexer
        setLocalValue(new TextDecoder().decode(keyValue.value.bytes as Uint8Array));
      } else {
        setLocalValue(keyValue.value.uint);
      }
    } catch (err) {
      console.error('Failed to load local value:', err);
      setLocalValue(
        `Error: ${err instanceof Error ? err.message : 'Unknown'}`
      );
    }
  };

  const handleClose = () => {
    navigation.goBack();
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Application Info"
          showBackButton
          onBackPress={handleClose}
          onAccountSelectorPress={() => {}}
          showAccountSelector={false}
        />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading application info...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Application Info"
          showBackButton
          onBackPress={handleClose}
          onAccountSelectorPress={() => {}}
          showAccountSelector={false}
        />
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle" size={48} color="#EF4444" />
          <Text style={styles.errorTitle}>Failed to Load</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={loadAppInfo}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title="Application Info"
        showBackButton
        onBackPress={handleClose}
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* App Overview */}
        <GlassCard style={styles.card}>
          <View style={styles.appHeader}>
            <View style={styles.appIconContainer}>
              <Ionicons name="cube" size={32} color={colors.primary} />
            </View>
            <View style={styles.appHeaderText}>
              <Text style={styles.appId}>App #{params.appId}</Text>
              <Text style={styles.networkName}>{networkConfig.name}</Text>
            </View>
          </View>
        </GlassCard>

        {/* Creator */}
        {appInfo?.creator && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Creator</Text>
            <Text style={styles.addressText}>
              {formatAddress(appInfo.creator)}
            </Text>
            <Text style={styles.fullAddress} selectable>
              {appInfo.creator}
            </Text>
          </GlassCard>
        )}

        {/* State Schema */}
        {(appInfo?.globalStateSchema || appInfo?.localStateSchema) && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>State Schema</Text>

            {appInfo.globalStateSchema && (
              <View style={styles.schemaSection}>
                <Text style={styles.schemaLabel}>Global State</Text>
                <Text style={styles.schemaValue}>
                  {appInfo.globalStateSchema.numUint} uint,{' '}
                  {appInfo.globalStateSchema.numByteSlice} bytes
                </Text>
              </View>
            )}

            {appInfo.localStateSchema && (
              <View style={styles.schemaSection}>
                <Text style={styles.schemaLabel}>Local State</Text>
                <Text style={styles.schemaValue}>
                  {appInfo.localStateSchema.numUint} uint,{' '}
                  {appInfo.localStateSchema.numByteSlice} bytes
                </Text>
              </View>
            )}
          </GlassCard>
        )}

        {/* Box Value (if queried) */}
        {params.queryParams?.box && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Box Value</Text>
            <View style={styles.queryResult}>
              <Text style={styles.queryLabel}>Key:</Text>
              <Text style={styles.queryKey} numberOfLines={1}>
                {params.queryParams.box}
              </Text>
            </View>
            <View style={styles.queryResult}>
              <Text style={styles.queryLabel}>Value:</Text>
              <Text style={styles.queryValue} selectable>
                {boxValue ?? 'Loading...'}
              </Text>
            </View>
          </GlassCard>
        )}

        {/* Global Value (if queried) */}
        {params.queryParams?.global && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Global State Value</Text>
            <View style={styles.queryResult}>
              <Text style={styles.queryLabel}>Key:</Text>
              <Text style={styles.queryKey} numberOfLines={1}>
                {params.queryParams.global}
              </Text>
            </View>
            <View style={styles.queryResult}>
              <Text style={styles.queryLabel}>Value:</Text>
              <Text style={styles.queryValue} selectable>
                {globalValue !== null
                  ? JSON.stringify(globalValue)
                  : 'Loading...'}
              </Text>
            </View>
          </GlassCard>
        )}

        {/* Local Value (if queried) */}
        {params.queryParams?.local && params.queryParams?.algorandaddress && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Local State Value</Text>
            <View style={styles.queryResult}>
              <Text style={styles.queryLabel}>Account:</Text>
              <Text style={styles.queryKey} numberOfLines={1}>
                {formatAddress(params.queryParams.algorandaddress)}
              </Text>
            </View>
            <View style={styles.queryResult}>
              <Text style={styles.queryLabel}>Key:</Text>
              <Text style={styles.queryKey} numberOfLines={1}>
                {params.queryParams.local}
              </Text>
            </View>
            <View style={styles.queryResult}>
              <Text style={styles.queryLabel}>Value:</Text>
              <Text style={styles.queryValue} selectable>
                {localValue !== null
                  ? JSON.stringify(localValue)
                  : 'Loading...'}
              </Text>
            </View>
          </GlassCard>
        )}

        {/* Global State Preview */}
        {appInfo?.globalState &&
          Object.keys(appInfo.globalState).length > 0 && (
            <GlassCard style={styles.card}>
              <Text style={styles.cardTitle}>Global State</Text>
              {Object.entries(appInfo.globalState)
                .slice(0, 10)
                .map(([key, value]) => (
                  <View key={key} style={styles.stateRow}>
                    <Text style={styles.stateKey} numberOfLines={1}>
                      {key}
                    </Text>
                    <Text style={styles.stateValue} numberOfLines={1}>
                      {typeof value === 'object'
                        ? JSON.stringify(value)
                        : String(value)}
                    </Text>
                  </View>
                ))}
              {Object.keys(appInfo.globalState).length > 10 && (
                <Text style={styles.moreText}>
                  +{Object.keys(appInfo.globalState).length - 10} more entries
                </Text>
              )}
            </GlassCard>
          )}
      </ScrollView>

      {/* Close Button */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
          <Text style={styles.closeButtonText}>Close</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: 16,
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
    },
    errorContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
      gap: 16,
    },
    errorTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
    },
    errorMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    retryButton: {
      paddingHorizontal: 24,
      paddingVertical: 12,
      backgroundColor: theme.colors.primary,
      borderRadius: 8,
      marginTop: 8,
    },
    retryButtonText: {
      color: '#FFFFFF',
      fontWeight: '600',
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      padding: 16,
      paddingBottom: 100,
    },
    card: {
      marginBottom: 16,
      padding: 16,
    },
    cardTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginBottom: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    appHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    appIconContainer: {
      width: 56,
      height: 56,
      borderRadius: 12,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
    },
    appHeaderText: {
      flex: 1,
    },
    appId: {
      fontSize: 24,
      fontWeight: '700',
      color: theme.colors.text,
    },
    networkName: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    addressText: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 4,
    },
    fullAddress: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      fontFamily: 'monospace',
    },
    schemaSection: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    schemaLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    schemaValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
    },
    queryResult: {
      marginBottom: 12,
    },
    queryLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    queryKey: {
      fontSize: 13,
      color: theme.colors.text,
      fontFamily: 'monospace',
      backgroundColor: theme.colors.surface,
      padding: 8,
      borderRadius: 4,
    },
    queryValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
      backgroundColor: theme.colors.surface,
      padding: 12,
      borderRadius: 8,
      fontFamily: 'monospace',
    },
    stateRow: {
      flexDirection: 'row',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      gap: 12,
    },
    stateKey: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      flex: 1,
      fontFamily: 'monospace',
    },
    stateValue: {
      fontSize: 13,
      color: theme.colors.text,
      flex: 2,
      textAlign: 'right',
      fontFamily: 'monospace',
    },
    moreText: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: 12,
    },
    buttonContainer: {
      padding: 16,
      paddingBottom: 32,
      backgroundColor: theme.colors.background,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    closeButton: {
      paddingVertical: 16,
      borderRadius: 12,
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
    },
    closeButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#FFFFFF',
    },
  });

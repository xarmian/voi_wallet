import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { formatAddress } from '@/utils/address';
import EnvoiService, { EnvoiNameInfo } from '@/services/envoi';
import UnifiedTransactionAuthModal from '@/components/UnifiedTransactionAuthModal';
import TransactionVerification from '@/components/ledger/TransactionVerification';
import {
  useTransactionAuthController,
  TransactionAuthController
} from '@/services/auth/transactionAuthController';
import {
  unifiedSigner,
  UnifiedTransactionRequest
} from '@/services/transactions/unifiedSigner';
import UniversalHeader from '@/components/common/UniversalHeader';
import { WalletStackParamList } from '@/navigation/AppNavigator';
import { WalletAccount } from '@/types/wallet';
import { NFTToken } from '@/types/nft';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { useCurrentNetwork } from '@/store/networkStore';
// Removed TransactionConfirmationCard in favor of unified TransactionVerification
import EnvoiProfileCard from '@/components/envoi/EnvoiProfileCard';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import tokenMappingService from '@/services/token-mapping';
import VoiNetworkService, { NetworkService } from '@/services/network';
import { useMultiNetworkBalance } from '@/store/walletStore';


type TransactionConfirmationScreenRouteProp = RouteProp<
  WalletStackParamList,
  'TransactionConfirmation'
>;
type TransactionConfirmationScreenNavigationProp = StackNavigationProp<
  WalletStackParamList,
  'TransactionConfirmation'
>;

interface TransactionConfirmationParams {
  recipient: string;
  recipientName?: string;
  amount: string;
  assetSymbol: string;
  assetId?: number;
  assetType?: 'voi' | 'asa' | 'arc200' | 'arc72';
  contractId?: number;
  tokenId?: string;
  assetDecimals?: number;
  note?: string;
  estimatedFee: number;
  fromAccount: WalletAccount;
  nftToken?: NFTToken;
  networkId?: string;
  assetImageUrl?: string;
  mappingId?: string;
}

export default function TransactionConfirmationScreen() {
  const route = useRoute<TransactionConfirmationScreenRouteProp>();
  const navigation =
    useNavigation<TransactionConfirmationScreenNavigationProp>();
  const params = route.params as TransactionConfirmationParams;
  const styles = useThemedStyles(createStyles);
  const currentNetwork = useCurrentNetwork();

  // Get network configuration
  const selectedNetworkId = (params.networkId as NetworkId) || currentNetwork;
  console.log('[TransactionConfirmation] params.networkId:', params.networkId, 'selectedNetworkId:', selectedNetworkId, 'currentNetwork:', currentNetwork);
  const networkConfig = getNetworkConfig(selectedNetworkId);

  const [envoiProfile, setEnvoiProfile] = useState<EnvoiNameInfo | null>(null);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentRequest, setCurrentRequest] = useState<UnifiedTransactionRequest | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [fallbackImageUrl, setFallbackImageUrl] = useState<string | undefined>(undefined);

  // Use the unified auth controller
  const authController = useTransactionAuthController();

  // Get multi-network balance to find asset images from other networks
  const { balance: multiNetworkBalance } = useMultiNetworkBalance(params.fromAccount?.id || '');

  useEffect(() => {
    loadEnvoiProfile();
  }, [params.recipient]);

  useEffect(() => {
    loadFallbackImage();
  }, [params.mappingId, params.assetImageUrl, params.assetId, selectedNetworkId]);

  useEffect(() => {
    return () => {
      authController.cleanup();
    };
  }, [authController]);


  const loadEnvoiProfile = async () => {
    if (!params.recipient) return;

    setIsLoadingProfile(true);
    try {
      const envoi = EnvoiService.getInstance();
      const profile = await envoi.getName(params.recipient);
      setEnvoiProfile(profile);
    } catch (error) {
      console.error('Failed to load Envoi profile:', error);
    } finally {
      setIsLoadingProfile(false);
    }
  };

  const loadFallbackImage = async () => {
    // If we already have an asset image, no need for fallback
    if (params.assetImageUrl) {
      setFallbackImageUrl(undefined);
      return;
    }

    // If no mapping ID, we can't find alternatives
    if (!params.mappingId) {
      setFallbackImageUrl(undefined);
      return;
    }

    // Don't load fallback for native tokens
    if (params.assetId === 0 || !params.assetId) {
      setFallbackImageUrl(undefined);
      return;
    }

    try {
      // Get the token mapping
      const mapping = tokenMappingService.getMappingForToken(
        params.assetId,
        selectedNetworkId
      );

      if (!mapping) {
        setFallbackImageUrl(undefined);
        return;
      }

      // Try to find an asset with an image URL from the multi-network balance
      if (multiNetworkBalance?.assets) {
        for (const asset of multiNetworkBalance.assets) {
          // Check if this asset is in the same mapping
          if (asset.mappingId === params.mappingId && asset.imageUrl) {
            console.log(`[TransactionConfirmation] Using fallback image from ${asset.symbol} on ${asset.networkId}`);
            setFallbackImageUrl(asset.imageUrl);
            return;
          }
        }
      }

      // If we still don't have an image, try fetching asset data from other networks in the mapping
      for (const token of mapping.tokens) {
        // Skip the current asset
        if (token.assetId === params.assetId && token.networkId === selectedNetworkId) {
          continue;
        }

        try {
          const networkService = NetworkService.getInstance(token.networkId);
          const balance = await networkService.getAccountBalance(params.fromAccount.address);
          const asset = balance?.assets?.find(a => a.assetId === token.assetId);

          if (asset?.imageUrl) {
            console.log(`[TransactionConfirmation] Using fallback image from ${token.symbol} on ${token.networkId}`);
            setFallbackImageUrl(asset.imageUrl);
            return;
          }
        } catch (error) {
          console.log(`[TransactionConfirmation] Failed to fetch asset data from ${token.networkId}:`, error);
          // Continue to next token
        }
      }

      setFallbackImageUrl(undefined);
    } catch (error) {
      console.error('[TransactionConfirmation] Failed to load fallback image:', error);
      setFallbackImageUrl(undefined);
    }
  };


  const handleConfirm = () => {
    // Create unified transaction request
    const amountInBaseUnits = params.assetType === 'arc72' ? 0 : convertAmountToBaseUnits(params.amount);

    const request: UnifiedTransactionRequest = {
      type: params.assetType === 'arc200'
        ? 'arc200_transfer'
        : params.assetType === 'asa'
        ? 'asa_transfer'
        : params.assetType === 'arc72'
        ? 'arc72_transfer'
        : 'voi_transfer',
      account: params.fromAccount,
      transferParams: {
        from: params.fromAccount.address,
        to: params.recipient.trim(),
        amount: amountInBaseUnits,
        assetId: params.assetId,
        assetType: params.assetType,
        contractId: params.contractId,
        tokenId: params.tokenId,
        note: params.note || undefined,
        networkId: selectedNetworkId,
      },
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  };

  const handleCancel = () => {
    navigation.goBack();
  };

  const convertAmountToBaseUnits = (amount: string): number => {
    const decimals =
      params.assetDecimals || (params.assetId === 0 || !params.assetId ? 6 : 0);
    const multiplier = Math.pow(10, decimals);
    return Math.floor(parseFloat(amount) * multiplier);
  };


  const handleAuthComplete = (success: boolean, result?: any) => {
    setShowAuthModal(false);
    setCurrentRequest(null);

    if (success && result?.transactionId) {
      // Replace this screen with result to keep stack cleaner
      navigation.replace('TransactionResult', {
        transactionId: result.transactionId,
        recipient: params.recipient,
        recipientName: getDisplayName(),
        amount: params.amount,
        assetSymbol: params.assetSymbol,
        assetId: params.assetId,
        assetType: params.assetType,
        contractId: params.contractId,
        tokenId: params.tokenId,
        fee: params.estimatedFee,
        isSuccess: true,
        homeRoute: params.assetType === 'arc72' ? 'NFTMain' : 'HomeMain',
        networkId: params.networkId,
      });
    } else {
      // Replace this screen with error result
      const errorMessage = result instanceof Error
        ? result.message
        : 'Transaction failed';

      navigation.replace('TransactionResult', {
        recipient: params.recipient,
        recipientName: getDisplayName(),
        amount: params.amount,
        assetSymbol: params.assetSymbol,
        assetId: params.assetId,
        assetType: params.assetType,
        contractId: params.contractId,
        tokenId: params.tokenId,
        fee: params.estimatedFee,
        isSuccess: false,
        errorMessage,
        homeRoute: params.assetType === 'arc72' ? 'NFTMain' : 'HomeMain',
        networkId: params.networkId,
      });
    }
  };

  const handleAuthCancel = () => {
    setShowAuthModal(false);
    setCurrentRequest(null);
  };

  const getDisplayName = () => {
    if (params.recipientName) {
      return params.recipientName;
    }
    if (envoiProfile?.name) {
      return envoiProfile.name;
    }
    return formatAddress(params.recipient);
  };

  const getTotalAmount = () => {
    // For ARC-72 NFT transfers, don't show a total since it's not meaningful
    if (params.assetType === 'arc72') {
      return undefined;
    }

    if (params.assetId === 0 || !params.assetId) {
      // For VOI, add fee to amount
      return (
        parseFloat(params.amount) +
        params.estimatedFee / 1000000
      ).toFixed(6);
    }
    // For other assets, fee is separate
    return params.amount;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title="Confirm Transaction"
        subtitle="Review transaction details before sending"
        showBackButton
        onBackPress={handleCancel}
      />

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Recipient Profile */}
        <EnvoiProfileCard
          address={params.recipient}
          name={params.recipientName}
          envoiProfile={envoiProfile}
          isLoading={isLoadingProfile}
        />

        {/* Unified Transaction Details + Verification */}
        <TransactionVerification
          fromAddress={params.fromAccount.address}
          signingAddress={params.fromAccount.address} // Simplified for now
          recipient={params.recipient}
          recipientLabel={getDisplayName()}
          amount={params.amount}
          assetSymbol={params.assetSymbol}
          assetId={params.assetId}
          fee={params.estimatedFee}
          total={getTotalAmount()}
          note={params.note}
          networkToken={networkConfig.nativeToken}
          isVoiTransaction={params.assetType !== 'arc72' && (params.assetId === 0 || !params.assetId)}
          isNftTransfer={params.assetType === 'arc72'}
          nftToken={params.nftToken}
          isLedgerSigner={false} // Will be handled by auth controller
          canSign={true} // Will be validated by unified signer
          networkName={params.networkId ? networkConfig.name : undefined}
          networkColor={params.networkId ? networkConfig.color : undefined}
          assetImageUrl={params.assetImageUrl || fallbackImageUrl}
        />
      </ScrollView>

      {/* Action Buttons */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.cancelButton]}
          onPress={handleCancel}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.confirmButton]}
          onPress={handleConfirm}
        >
          <Text style={styles.confirmButtonText}>Confirm & Send</Text>
        </TouchableOpacity>
      </View>

      <UnifiedTransactionAuthModal
        visible={showAuthModal}
        controller={authController}
        request={currentRequest}
        onComplete={handleAuthComplete}
        onCancel={handleAuthCancel}
        title="Authorize Transaction"
        message={`Authenticate to send ${params.amount} ${params.assetSymbol} to ${getDisplayName()}`}
      />
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flex: 1,
      paddingHorizontal: theme.spacing.md,
    },
    buttonContainer: {
      flexDirection: 'row',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    button: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.card,
      borderWidth: 2,
      borderColor: theme.colors.border,
    },
    confirmButton: {
      backgroundColor: theme.colors.primary,
    },
    cancelButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textSecondary,
    },
    confirmButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    sendingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
  });

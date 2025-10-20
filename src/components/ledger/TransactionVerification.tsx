import React, { useState } from 'react';
import { StyleSheet, Text, View, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Theme } from '@/constants/themes';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { formatAddress } from '@/utils/address';
import { NFTToken } from '@/types/nft';
import { normalizeAssetImageUrl } from '@/utils/assetImages';

interface TransactionVerificationProps {
  fromAddress: string;
  signingAddress?: string | null;
  recipient: string;
  recipientLabel?: string;
  amount: string;
  assetSymbol: string;
  assetId?: number;
  fee: number;
  total?: string;
  note?: string;
  networkToken?: string;
  isVoiTransaction?: boolean;
  isLedgerSigner?: boolean;
  canSign?: boolean;
  isNftTransfer?: boolean;
  nftToken?: NFTToken;
  assetImageUrl?: string;
  networkName?: string;
  networkColor?: string;
}

const TransactionVerification: React.FC<TransactionVerificationProps> = ({
  fromAddress,
  signingAddress,
  recipient,
  recipientLabel,
  amount,
  assetSymbol,
  assetId,
  fee,
  total,
  note,
  networkToken,
  isVoiTransaction = false,
  isLedgerSigner = false,
  canSign,
  isNftTransfer = false,
  nftToken,
  assetImageUrl,
  networkName,
  networkColor,
}) => {
  const styles = useThemedStyles(createStyles);
  const [imageError, setImageError] = useState(false);

  const resolvedRecipient = recipientLabel || formatAddress(recipient);
  const resolvedSigningAddress =
    signingAddress && signingAddress !== fromAddress
      ? formatAddress(signingAddress)
      : null;

  const renderAssetImage = () => {
    // For native VOI transfers, don't show an image in the amount section
    if (isVoiTransaction) {
      return null;
    }

    // For NFT transfers, show the NFT image if available
    if (isNftTransfer) {
      const nftImageUrl = nftToken?.imageUrl || assetImageUrl;
      const normalizedNftImageUrl = normalizeAssetImageUrl(nftImageUrl);

      if (!normalizedNftImageUrl || imageError) {
        return (
          <View style={styles.nftImagePlaceholder}>
            <Ionicons
              name="image-outline"
              size={48}
              color={styles.assetIconPlaceholder.color}
            />
          </View>
        );
      }

      return (
        <Image
          source={{ uri: normalizedNftImageUrl }}
          style={styles.nftImage}
          onError={() => setImageError(true)}
        />
      );
    }

    const normalizedImageUrl = normalizeAssetImageUrl(assetImageUrl);

    if (!normalizedImageUrl || imageError) {
      return (
        <View style={styles.assetIconPlaceholder}>
          <Ionicons
            name="disc"
            size={32}
            color={styles.assetIconPlaceholder.color}
          />
        </View>
      );
    }

    return (
      <Image
        source={{ uri: normalizedImageUrl }}
        style={styles.assetIcon}
        onError={() => setImageError(true)}
      />
    );
  };

  return (
    <View style={styles.container}>
      {/* Network indicator at the top if provided */}
      {networkName && networkColor && (
        <View style={styles.networkHeader}>
          <View style={[styles.networkDot, { backgroundColor: networkColor }]} />
          <Text style={styles.networkText}>Sending on {networkName}</Text>
        </View>
      )}

      <Text style={styles.title}>Transaction Details</Text>

      {/* Prominent amount section */}
      <View style={styles.amountSection}>
        <Text style={styles.amountLabel}>You're sending</Text>

        {renderAssetImage()}

        <Text style={styles.amountValue}>
          {isNftTransfer
            ? `1 NFT`
            : `${amount} ${assetSymbol}`
          }
        </Text>

        {isNftTransfer && nftToken && (
          <Text style={styles.nftName}>
            {nftToken.metadata.name || `Token #${nftToken.tokenId}`}
          </Text>
        )}

        {!isNftTransfer && !isVoiTransaction && assetId !== undefined && (
          <Text style={styles.assetId}>Asset ID: {assetId}</Text>
        )}
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>From</Text>
        <Text style={styles.value}>{formatAddress(fromAddress)}</Text>
      </View>

      {resolvedSigningAddress ? (
        <View style={styles.row}>
          <Text style={styles.label}>Signing Address</Text>
          <View style={styles.signingStatusContainer}>
            <Text style={styles.value}>{resolvedSigningAddress}</Text>
            {isLedgerSigner ? (
              <Text
                style={[
                  styles.signingBadge,
                  canSign
                    ? styles.signingBadgeReady
                    : styles.signingBadgeWarning,
                ]}
              >
                Ledger
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={styles.row}>
        <Text style={styles.label}>To</Text>
        <Text style={styles.value}>{resolvedRecipient}</Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Fee</Text>
        <Text style={styles.value}>
          {(fee / 1_000_000).toFixed(6)} {networkToken || 'VOI'}
        </Text>
      </View>

      {isVoiTransaction && total && !isNftTransfer ? (
        <View style={[styles.row, styles.totalRow]}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>
            {total} {networkToken || 'VOI'}
          </Text>
        </View>
      ) : null}

      {note ? (
        <View style={styles.noteContainer}>
          <Text style={styles.label}>Note</Text>
          <Text style={styles.noteText}>{note}</Text>
        </View>
      ) : null}

      {isLedgerSigner ? (
        <View style={styles.ledgerHint}>
          <Text style={styles.ledgerHintText}>
            Review and confirm this transaction on your Ledger device when
            prompted.
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
      ...theme.shadows.md,
    },
    networkHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingBottom: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    networkDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    networkText: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.textSecondary,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    amountSection: {
      alignItems: 'center',
      paddingVertical: theme.spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      gap: theme.spacing.sm,
    },
    amountLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    assetIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
    },
    assetIconPlaceholder: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      color: theme.colors.textSecondary,
    },
    nftImage: {
      width: 120,
      height: 120,
      borderRadius: theme.borderRadius.md,
    },
    nftImagePlaceholder: {
      width: 120,
      height: 120,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      color: theme.colors.textSecondary,
    },
    amountValue: {
      fontSize: 32,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    assetId: {
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.textSecondary,
    },
    nftName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    row: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingVertical: theme.spacing.sm,
    },
    label: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    value: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    signingStatusContainer: {
      gap: theme.spacing.xs,
    },
    signingBadge: {
      fontSize: 12,
      fontWeight: '600',
      alignSelf: 'flex-start',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
    },
    signingBadgeReady: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(52, 199, 89, 0.12)'
          : 'rgba(48, 209, 88, 0.24)',
      color: theme.colors.success,
    },
    signingBadgeWarning: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255, 149, 0, 0.12)'
          : 'rgba(255, 159, 10, 0.24)',
      color: theme.colors.warning,
    },
    totalRow: {
      borderBottomWidth: 0,
      paddingTop: theme.spacing.sm,
    },
    totalLabel: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    totalValue: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    noteContainer: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    noteText: {
      fontSize: 14,
      color: theme.colors.text,
      lineHeight: 18,
    },
    ledgerHint: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(0, 122, 255, 0.08)'
          : 'rgba(10, 132, 255, 0.18)',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
    },
    ledgerHintText: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
  });

export default TransactionVerification;

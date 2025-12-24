import React, { useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetDefaultBackdropProps } from '@gorhom/bottom-sheet/lib/typescript/components/bottomSheetBackdrop/types';
import { useWalletStore } from '@/store/walletStore';
import { AccountType } from '@/types/wallet';

interface AddAccountModalProps {
  isVisible: boolean;
  onClose: () => void;
  onCreateAccount: () => void;
  onImportAccount: () => void;
  onImportQRAccount: () => void;
  onAddWatchAccount: () => void;
  onImportLedgerAccount: () => void;
  /** Hide watch account option - used in airgap mode where only signable accounts are relevant */
  airgapMode?: boolean;
}

export default function AddAccountModal({
  isVisible,
  onClose,
  onCreateAccount,
  onImportAccount,
  onImportQRAccount,
  onAddWatchAccount,
  onImportLedgerAccount,
  airgapMode = false,
}: AddAccountModalProps) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const createAccount = useWalletStore((state) => state.createAccount);
  const importAccount = useWalletStore((state) => state.importAccount);
  const addWatchAccount = useWalletStore((state) => state.addWatchAccount);

  // Handle sheet changes
  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        onClose();
      }
    },
    [onClose]
  );

  // Render backdrop
  const renderBackdrop = useCallback(
    (props: BottomSheetDefaultBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  // Handle account creation - navigate to proper backup flow
  const handleCreateAccount = async () => {
    onClose();
    onCreateAccount(); // This will navigate to CreateAccountScreen
  };

  // Open/close the bottom sheet based on visibility
  React.useEffect(() => {
    if (isVisible) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [isVisible]);

  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const accountOptions = useMemo(() => {
    const allOptions = [
      {
        id: 'create',
        title: 'Create New Account',
        subtitle: 'Generate a new account and backup its recovery phrase',
        icon: 'add-circle-outline' as const,
        onPress: handleCreateAccount,
      },
      {
        id: 'import',
        title: 'Import Account',
        subtitle: 'Import existing account with seed phrase or private key',
        icon: 'download-outline' as const,
        onPress: () => {
          onClose();
          onImportAccount();
        },
      },
      {
        id: 'ledger',
        title: 'Connect Ledger',
        subtitle: 'Import accounts secured by a Ledger hardware wallet',
        icon: 'hardware-chip-outline' as const,
        onPress: () => {
          onClose();
          onImportLedgerAccount();
        },
      },
      {
        id: 'importQR',
        title: 'Import via QR Code',
        subtitle: 'Scan QR codes to import multiple accounts',
        icon: 'qr-code-outline' as const,
        onPress: () => {
          onClose();
          onImportQRAccount();
        },
      },
      {
        id: 'watch',
        title: 'Add Watch Account',
        subtitle: 'Monitor an account without private key access',
        icon: 'eye-outline' as const,
        onPress: () => {
          onClose();
          onAddWatchAccount();
        },
      },
    ];

    // In airgap mode, hide watch account option since watch accounts can't sign
    if (airgapMode) {
      return allOptions.filter((option) => option.id !== 'watch');
    }

    return allOptions;
  }, [
    airgapMode,
    handleCreateAccount,
    onClose,
    onImportAccount,
    onImportLedgerAccount,
    onImportQRAccount,
    onAddWatchAccount,
  ]);

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      enableDynamicSizing
      onChange={handleSheetChanges}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      handleIndicatorStyle={styles.indicator}
      backgroundStyle={styles.bottomSheetBackground}
    >
      <BottomSheetView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Add Account</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Account Options */}
        <View style={styles.optionsContainer}>
          {accountOptions.map((option) => (
            <TouchableOpacity
              key={option.id}
              style={styles.optionItem}
              onPress={option.onPress}
              activeOpacity={0.7}
            >
              <View style={styles.optionIcon}>
                <Ionicons name={option.icon} size={24} color={colors.primary} />
              </View>
              <View style={styles.optionContent}>
                <Text style={styles.optionTitle}>{option.title}</Text>
                <Text style={styles.optionSubtitle}>{option.subtitle}</Text>
              </View>
              <Ionicons
                name="chevron-forward"
                size={20}
                color={colors.textMuted}
              />
            </TouchableOpacity>
          ))}
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.modalBackground,
    },
    bottomSheetBackground: {
      backgroundColor: theme.colors.modalBackground,
      borderTopLeftRadius: theme.borderRadius.xl + 4,
      borderTopRightRadius: theme.borderRadius.xl + 4,
    },
    indicator: {
      backgroundColor: theme.colors.borderLight,
      width: 32,
      height: 4,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    optionsContainer: {
      paddingVertical: theme.spacing.sm,
    },
    optionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    optionIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor:
        theme.mode === 'light' ? '#EBF4FF' : 'rgba(10, 132, 255, 0.2)',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    optionContent: {
      flex: 1,
    },
    optionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    optionSubtitle: {
      fontSize: 14,
      color: theme.colors.textMuted,
      lineHeight: 20,
    },
  });

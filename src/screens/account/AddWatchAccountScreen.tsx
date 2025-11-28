import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp, useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as algosdk from 'algosdk';
import { useWalletStore } from '@/store/walletStore';
import { AccountType } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { getFromClipboard } from '@/utils/clipboard';

type AddWatchAccountScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'AddWatchAccount'
>;

type AddWatchAccountScreenRouteProp = RouteProp<
  RootStackParamList,
  'AddWatchAccount'
>;

interface Props {
  navigation: AddWatchAccountScreenNavigationProp;
  route: AddWatchAccountScreenRouteProp;
}

export default function AddWatchAccountScreen() {
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<AddWatchAccountScreenNavigationProp>();
  const route = useRoute<AddWatchAccountScreenRouteProp>();
  const addWatchAccount = useWalletStore((state) => state.addWatchAccount);

  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (route.params?.isOnboarding) {
        return undefined;
      }

      const state = navigation.getState() as
        | {
            type?: string;
            routes?: Array<{ name: string; params?: unknown }>;
          }
        | undefined;

      if (
        state?.type === 'stack' &&
        state.routes?.length === 1 &&
        state.routes[0]?.name === 'AddWatchAccount'
      ) {
        const currentParams = state.routes[0]?.params;

        navigation.reset({
          index: 1,
          routes: [
            { name: 'SettingsMain' as never },
            { name: 'AddWatchAccount' as never, params: currentParams },
          ],
        });
      }

      return undefined;
    }, [navigation, route.params?.isOnboarding])
  );

  const validateAddress = (addr: string): boolean => {
    if (!addr.trim()) return false;
    try {
      return algosdk.isValidAddress(addr.trim());
    } catch {
      return false;
    }
  };

  const handleAddWatchAccount = async () => {
    const trimmedAddress = address.trim();

    if (!trimmedAddress) {
      Alert.alert('Error', 'Please enter an Algorand address');
      return;
    }

    if (!validateAddress(trimmedAddress)) {
      Alert.alert('Error', 'Please enter a valid Algorand address');
      return;
    }

    setIsLoading(true);

    try {
      const isOnboarding = route.params?.isOnboarding;

      if (isOnboarding) {
        // For onboarding, check if PIN is set up
        const hasPin = await AccountSecureStorage.hasPin();

        if (!hasPin) {
          // No PIN setup - route through SecuritySetupScreen with a placeholder account
          const watchAccount = {
            id: `watch-${Date.now()}`,
            address: trimmedAddress,
            name:
              label.trim() ||
              `Watch Account ${new Date().toLocaleDateString()}`,
            type: 'watch' as const,
            isValid: true,
            isDuplicate: false,
            mnemonic: undefined,
            privateKey: undefined,
          };

          navigation.navigate('SecuritySetup', {
            accounts: [watchAccount],
            source: 'watch',
          });
          return;
        }
      }

      // Proceed with adding the watch account
      await addWatchAccount({
        type: AccountType.WATCH,
        address: trimmedAddress,
        label: label.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      if (isOnboarding) {
        // PIN exists - navigate to Main app after adding watch account
        Alert.alert('Success', 'Watch account added successfully!', [
          { text: 'OK', onPress: () => navigation.navigate('Main') },
        ]);
      } else {
        Alert.alert('Success', 'Watch account added successfully!', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      }
    } catch (error) {
      console.error('Failed to add watch account:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to add watch account';
      Alert.alert('Error', errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasteAddress = async () => {
    try {
      const clipboardText = (await getFromClipboard()).trim();
      if (clipboardText && validateAddress(clipboardText)) {
        setAddress(clipboardText);
      } else {
        Alert.alert(
          'Error',
          'Clipboard does not contain a valid Algorand address'
        );
      }
    } catch (error) {
      console.error('Failed to paste from clipboard:', error);
      Alert.alert('Error', 'Failed to access clipboard');
    }
  };

  const isAddressValid = validateAddress(address);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons
            name="arrow-back"
            size={24}
            color={styles.backButtonColor}
          />
        </TouchableOpacity>
        <Text style={styles.title}>Add Watch Account</Text>
        <View style={styles.placeholder} />
      </View>

      <KeyboardAwareScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
      >
          {/* Information Card */}
          <View style={styles.infoCard}>
            <Ionicons
              name="eye-outline"
              size={24}
              color={styles.primaryColor}
              style={styles.infoIcon}
            />
            <View style={styles.infoContent}>
              <Text style={styles.infoTitle}>Watch Only Account</Text>
              <Text style={styles.infoDescription}>
                Watch accounts allow you to monitor any Algorand address without
                requiring the private key. You can view balances and transaction
                history, but cannot send transactions.
              </Text>
            </View>
          </View>

          {/* Address Input */}
          <View style={styles.inputSection}>
            <Text style={styles.inputLabel}>Algorand Address *</Text>
            <View style={styles.addressInputContainer}>
              <TextInput
                style={[
                  styles.addressInput,
                  address &&
                    (isAddressValid ? styles.validInput : styles.invalidInput),
                ]}
                value={address}
                onChangeText={setAddress}
                placeholder="Enter address (58 characters)"
                placeholderTextColor={styles.placeholderColor}
                multiline
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
              <TouchableOpacity
                style={styles.pasteButton}
                onPress={handlePasteAddress}
              >
                <Ionicons
                  name="clipboard-outline"
                  size={20}
                  color={styles.primaryColor}
                />
                <Text style={styles.pasteText}>Paste</Text>
              </TouchableOpacity>
            </View>
            {address && !isAddressValid && (
              <Text style={styles.errorText}>Invalid Algorand address</Text>
            )}
          </View>

          {/* Label Input */}
          <View style={styles.inputSection}>
            <Text style={styles.inputLabel}>Account Label (Optional)</Text>
            <TextInput
              style={styles.textInput}
              value={label}
              onChangeText={setLabel}
              placeholder="e.g., Trading Account, Cold Storage"
              placeholderTextColor={styles.placeholderColor}
              maxLength={50}
            />
          </View>

          {/* Notes Input */}
          <View style={styles.inputSection}>
            <Text style={styles.inputLabel}>Notes (Optional)</Text>
            <TextInput
              style={[styles.textInput, styles.notesInput]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Add any notes about this account..."
              placeholderTextColor={styles.placeholderColor}
              multiline
              textAlignVertical="top"
              maxLength={200}
            />
          </View>

        {/* Add Button */}
        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[
              styles.addButton,
              (!isAddressValid || isLoading) && styles.disabledButton,
            ]}
            onPress={handleAddWatchAccount}
            disabled={!isAddressValid || isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <>
                <Ionicons
                  name="eye-outline"
                  size={20}
                  color={styles.buttonTextColor}
                />
                <Text style={styles.addButtonText}>Add Watch Account</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    scrollContent: {
      flexGrow: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    backButton: {
      padding: theme.spacing.xs,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 32,
    },
    content: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
    },
    infoCard: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    infoIcon: {
      marginRight: theme.spacing.lg,
      marginTop: 2,
    },
    infoContent: {
      flex: 1,
    },
    infoTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    infoDescription: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      lineHeight: 20,
    },
    inputSection: {
      marginBottom: theme.spacing.lg,
    },
    inputLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      // Text shadow for readability over NFT backgrounds
      textShadowColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.8)'
        : 'rgba(255, 255, 255, 0.9)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 10,
    },
    addressInputContainer: {
      position: 'relative',
    },
    addressInput: {
      backgroundColor: theme.colors.inputBackground,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.lg,
      paddingRight: 80,
      fontSize: 14,
      color: theme.colors.text,
      minHeight: 80,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    validInput: {
      borderColor: theme.colors.success,
      backgroundColor: theme.colors.inputBackground,
    },
    invalidInput: {
      borderColor: theme.colors.error,
      backgroundColor: theme.colors.inputBackground,
    },
    pasteButton: {
      position: 'absolute',
      top: theme.spacing.lg,
      right: theme.spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      borderRadius: theme.borderRadius.md,
    },
    pasteText: {
      fontSize: 14,
      color: theme.colors.primary,
      marginLeft: theme.spacing.xs,
      fontWeight: '500',
    },
    textInput: {
      backgroundColor: theme.colors.inputBackground,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.lg,
      fontSize: 16,
      color: theme.colors.text,
    },
    notesInput: {
      minHeight: 80,
      textAlignVertical: 'top',
    },
    errorText: {
      fontSize: 14,
      color: theme.colors.error,
      marginTop: theme.spacing.xs,
    },
    buttonContainer: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
    },
    disabledButton: {
      backgroundColor: theme.colors.textMuted,
    },
    addButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
      marginLeft: theme.spacing.sm,
    },
    backButtonColor: theme.colors.text,
    primaryColor: theme.colors.primary,
    placeholderColor: theme.colors.placeholder,
    buttonTextColor: theme.colors.buttonText,
  });

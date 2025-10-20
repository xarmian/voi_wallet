import React from 'react';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import algosdk from 'algosdk';

import { RootStackParamList } from '@/navigation/AppNavigator';
import QRScanner from '@/components/walletconnect/QRScanner';
import { isAlgorandPaymentUri, parseAlgorandUri } from '@/utils/algorandUri';
import { isWalletConnectUri } from '@/services/walletconnect/utils';

type QRScannerScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'QRScanner'
>;
type QRScannerScreenRouteProp = RouteProp<RootStackParamList, 'QRScanner'>;

interface Props {
  navigation: QRScannerScreenNavigationProp;
  route: QRScannerScreenRouteProp;
}

const resolveAlgorandAddress = (value: string): string | null => {
  const candidate = value.trim();
  if (!candidate) {
    return null;
  }

  try {
    if (algosdk.isValidAddress(candidate)) {
      return candidate;
    }
  } catch (error) {
    console.error('Address validation failed:', error);
  }

  const upperCandidate = candidate.toUpperCase();
  if (upperCandidate !== candidate) {
    try {
      if (algosdk.isValidAddress(upperCandidate)) {
        return upperCandidate;
      }
    } catch (error) {
      console.error('Uppercase address validation failed:', error);
    }
  }

  return null;
};

export default function QRScannerScreen({ navigation }: Props) {

  const getPaymentParamsFromUri = (uri: string): Record<string, any> | null => {
    if (!isAlgorandPaymentUri(uri)) {
      return null;
    }

    try {
      const parsed = parseAlgorandUri(uri);

      if (!parsed || !parsed.isValid) {
        return null;
      }

      const params: Record<string, any> = {};

      if (parsed.address) {
        params.recipient = parsed.address;
      }

      if (parsed.params.amount) {
        params.amount = parsed.params.amount;
      }

      if (parsed.params.asset) {
        params.asset = parsed.params.asset;
      }

      if (parsed.params.note || parsed.params.xnote) {
        params.note = parsed.params.xnote || parsed.params.note;
      }

      if (parsed.params.label) {
        params.label = parsed.params.label;
      }

      return params;
    } catch (error) {
      console.error('Failed to parse payment URI:', error);
      return null;
    }
  };

  const isLegacyVoiSendUri = (uri: string): boolean => {
    const lower = uri.toLowerCase();
    return lower.startsWith('voi://send');
  };

  const handleClose = () => {
    // Check if we can go back, otherwise navigate to main
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Main', { screen: 'Home' });
    }
  };

  const handleSuccess = async (uri: string) => {
    const sanitized = uri.trim();
    const resolvedAddress = resolveAlgorandAddress(sanitized);
    const paymentParams = getPaymentParamsFromUri(sanitized);
    const hasTransferPayload =
      Boolean(paymentParams) || isLegacyVoiSendUri(sanitized);
    const sendParams =
      paymentParams ??
      (resolvedAddress || hasTransferPayload
        ? { qrResult: resolvedAddress ?? sanitized }
        : null);

    if (sendParams) {
      navigation.navigate('Main', {
        screen: 'Home',
        params: {
          screen: 'Send',
          params: sendParams,
        },
      });

      return;
    }

    // For WalletConnect URIs, don't auto-close - let the WalletConnect flow handle navigation
    // For other URIs, let the deep link service handle them and close the scanner after a delay
    if (isWalletConnectUri(sanitized)) {
      // Don't auto-close for WalletConnect URIs - the session proposal or error screen will handle navigation
      return;
    }

    setTimeout(() => {
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('Main', { screen: 'Home' });
      }
    }, 100);
  };

  return <QRScanner onClose={handleClose} onSuccess={handleSuccess} />;
}

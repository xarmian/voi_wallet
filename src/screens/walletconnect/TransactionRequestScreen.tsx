import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '@/navigation/AppNavigator';
import UniversalHeader from '@/components/common/UniversalHeader';
import {
  reviewGrant,
  walletConnectRequestKey,
} from '@/services/auth/reviewGrant';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
import type { CallbackNavigation } from '@/services/navigation/callbackRegistry';
import { scopedNavigation } from '@/services/navigation/scopedNavigation';
import {
  SignRequestController,
  type SignRequestSurface,
} from '@/services/walletconnect/signRequestController';

type TransactionRequestScreenNavigationProp = NativeStackNavigationProp<
  RootStackParamList,
  'WalletConnectTransactionRequest'
>;
type TransactionRequestScreenRouteProp = RouteProp<
  RootStackParamList,
  'WalletConnectTransactionRequest'
>;

interface Props {
  navigation: TransactionRequestScreenNavigationProp;
  route: TransactionRequestScreenRouteProp;
}

export default function TransactionRequestScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navRef = useRef<CallbackNavigation>(
    scopedNavigation(navigation, route.key)
  );
  const controllerRef = useRef<SignRequestController | null>(null);
  useEffect(() => {
    if (controllerRef.current === null) {
      const { requestEvent } = route.params;
      const version = (route.params as any)?.version as number | undefined;
      const requestKey = walletConnectRequestKey(
        (requestEvent as any)?.topic ?? '',
        (requestEvent as any)?.id ?? ''
      );
      const surface: SignRequestSurface = {
        presentReview: (params) => {
          navRef.current.replace('UniversalTransactionSigning', params);
        },
        presentError: (message) => {
          navRef.current.replace('WalletConnectError', { error: message });
        },
        adoptNavigation: (nav) => {
          navRef.current = nav ?? scopedNavigation(navigation, route.key);
        },
        takeNext: async (toast) => {
          let taken: Awaited<
            ReturnType<typeof TransactionRequestQueue.takeNext>
          >;
          try {
            taken = await TransactionRequestQueue.takeNext((req) => {
              if (
                !navRef.current.replace('WalletConnectTransactionRequest', {
                  requestEvent: req,
                  version: req.version,
                })
              )
                throw new Error('navigation target gone');
            });
            // Leaving this request ends only its own permission.
            if (!taken.request) reviewGrant.leave(requestKey);
          } catch (error) {
            reviewGrant.revoke();
            if (
              error instanceof Error &&
              error.message === 'navigation target gone'
            )
              return 'target-gone';
            toast(await TransactionRequestQueue.size());
            throw error;
          }
          toast(taken.remaining + (taken.request ? 1 : 0));
          return taken.request ? 'advanced' : 'empty';
        },
        leave: () => {
          if (navRef.current.canGoBack()) {
            navRef.current.goBack();
          } else {
            navRef.current.navigate('Main', { screen: 'Home' });
          }
        },
      };
      controllerRef.current = new SignRequestController({
        requestEvent,
        version,
        surface,
      });
    }
    void controllerRef.current!.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- One controller per mount, capturing the original route and navigation; callback navigation is adopted by the surface.
  }, []);

  useEffect(() => {
    return () => {
      controllerRef.current!.dispose();
    };
  }, []);

  // Navigation departure, not unmount: effect replay must not abandon a request.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        controllerRef.current!.leave();
      }),
    [navigation, route.key]
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title="WalletConnect Request"
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />
      <View style={styles.content}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.text}>Loading request…</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => controllerRef.current!.reject()}
        >
          <Text style={styles.buttonText}>Reject</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    content: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
    text: { color: theme.colors.text, textAlign: 'center' },
    button: {
      padding: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.primary,
    },
    buttonText: { color: theme.colors.buttonText, textAlign: 'center' },
  });

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RootStackParamList } from '@/navigation/AppNavigator';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type ErrorScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'WalletConnectError'
>;
type ErrorScreenRouteProp = RouteProp<RootStackParamList, 'WalletConnectError'>;

interface Props {
  navigation: ErrorScreenNavigationProp;
  route: ErrorScreenRouteProp;
}

export default function WalletConnectErrorScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const errorMessage = route.params?.error || 'Failed to connect';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title="WalletConnect"
        showBackButton
        onBackPress={() => {
          if (navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.navigate('Main', { screen: 'Home' });
          }
        }}
      />
      <View style={styles.content}>
        <Ionicons name="alert-circle" size={48} color={theme.colors.error} />
        <Text style={[styles.title, { marginTop: 12 }]}>Connection error</Text>
        <Text style={styles.message}>{errorMessage}</Text>

        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={() => {
            if (navigation.canGoBack()) {
              navigation.goBack();
            } else {
              navigation.navigate('Main', { screen: 'Home' });
            }
          }}
        >
          <Text style={styles.primaryButtonText}>Close</Text>
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
    content: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    message: {
      marginTop: 8,
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    button: {
      paddingHorizontal: 32,
      paddingVertical: 12,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 24,
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
    },
    primaryButtonText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
  });



import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ScrollView,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import UniversalHeader from '@/components/common/UniversalHeader';
import appJson from '../../../app.config.js';

// const packageJson = require('../../../package.json');

export default function AboutScreen() {
  const navigation = useNavigation();
  const styles = useThemedStyles(createStyles);

  const openURL = async (url: string, label: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        Alert.alert('Error', `Cannot open ${label}`);
      }
    } catch (error) {
      Alert.alert('Error', `Failed to open ${label}`);
    }
  };

  const handleTwitterPress = () => {
    openURL('https://twitter.com/Voi_Wallet', 'Twitter');
  };

  const handleWebsitePress = () => {
    openURL('https://getvoi.app', 'Website');
  };

  const handleCompanyPress = () => {
    openURL('https://perpetualsoftware.org', 'Perpetual Software website');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title="About"
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.logoContainer}>
          <Image
            source={require('../../../assets/voi_wallet_logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        <View style={styles.appInfoSection}>
          <Text style={styles.appName}>Voi Wallet</Text>
          <Text style={styles.version}>Version {appJson.expo.version}</Text>
          <Text style={styles.description}>
            A secure, decentralized wallet for the Voi Network
          </Text>
        </View>

        <View style={styles.linksSection}>
          <Text style={styles.sectionTitle}>Connect With Us</Text>

          <TouchableOpacity
            style={styles.linkItem}
            onPress={handleTwitterPress}
          >
            <Ionicons name="logo-twitter" size={24} color="#1DA1F2" />
            <View style={styles.linkTextContainer}>
              <Text style={styles.linkTitle}>Follow us on Twitter</Text>
              <Text style={styles.linkSubtitle}>@Voi_Wallet</Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={20}
              color={styles.arrow.color}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkItem}
            onPress={handleWebsitePress}
          >
            <Ionicons name="globe-outline" size={24} color="#007AFF" />
            <View style={styles.linkTextContainer}>
              <Text style={styles.linkTitle}>Visit our website</Text>
              <Text style={styles.linkSubtitle}>getvoi.app</Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={20}
              color={styles.arrow.color}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.companySection}>
          <Text style={styles.sectionTitle}>Developer</Text>

          <TouchableOpacity
            style={styles.linkItem}
            onPress={handleCompanyPress}
          >
            <Ionicons name="business-outline" size={24} color="#6B7280" />
            <View style={styles.linkTextContainer}>
              <Text style={styles.linkTitle}>Perpetual Software, LLC</Text>
              <Text style={styles.linkSubtitle}>perpetualsoftware.org</Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={20}
              color={styles.arrow.color}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.footerSection}>
          <Text style={styles.footerText}>
            Built for the Voi Network with ❤️
          </Text>
        </View>
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
    content: {
      flexGrow: 1,
      paddingHorizontal: 20,
      paddingVertical: 20,
    },
    logoContainer: {
      alignItems: 'center',
      marginBottom: 30,
      paddingVertical: 20,
    },
    logo: {
      width: 120,
      height: 120,
    },
    appInfoSection: {
      alignItems: 'center',
      marginBottom: 40,
    },
    appName: {
      fontSize: 28,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: 8,
    },
    version: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginBottom: 12,
    },
    description: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
      paddingHorizontal: 20,
    },
    linksSection: {
      backgroundColor: theme.colors.card,
      borderRadius: 15,
      marginBottom: 20,
      overflow: 'hidden',
    },
    companySection: {
      backgroundColor: theme.colors.card,
      borderRadius: 15,
      marginBottom: 30,
      overflow: 'hidden',
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textMuted,
      paddingHorizontal: 20,
      paddingVertical: 15,
      backgroundColor: theme.colors.surface,
    },
    linkItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    linkTextContainer: {
      flex: 1,
      marginLeft: 16,
    },
    linkTitle: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 2,
    },
    linkSubtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    arrow: {
      color: theme.colors.textMuted,
    },
    footerSection: {
      alignItems: 'center',
      paddingVertical: 20,
    },
    footerText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
  });

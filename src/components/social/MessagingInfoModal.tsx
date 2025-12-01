import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import { MESSAGE_FEE_DISPLAY } from '@/services/messaging/types';

interface MessagingInfoModalProps {
  visible: boolean;
  onClose: () => void;
}

interface InfoItemProps {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  iconColor?: string;
}

function InfoItem({ icon, title, description, iconColor }: InfoItemProps) {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();

  return (
    <View style={styles.infoItem}>
      <View style={[styles.iconContainer, { backgroundColor: (iconColor || theme.colors.primary) + '20' }]}>
        <Ionicons name={icon} size={20} color={iconColor || theme.colors.primary} />
      </View>
      <View style={styles.infoContent}>
        <Text style={styles.infoTitle}>{title}</Text>
        <Text style={styles.infoDescription}>{description}</Text>
      </View>
    </View>
  );
}

export default function MessagingInfoModal({ visible, onClose }: MessagingInfoModalProps) {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <BlurredContainer style={styles.modal} borderRadius={theme.borderRadius.xl}>
              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.title}>How Messaging Works</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Ionicons name="close" size={24} color={theme.colors.text} />
                </TouchableOpacity>
              </View>

              {/* Info Items */}
              <View style={styles.content}>
                <InfoItem
                  icon="lock-closed"
                  title="End-to-End Encrypted"
                  description="Messages are encrypted before being sent. Only you and the recipient can read them."
                  iconColor={theme.colors.success || '#10B981'}
                />

                <InfoItem
                  icon="cube-outline"
                  title="Blockchain Powered"
                  description="Each message is a transaction on the Voi blockchain. Messages are permanent and cannot be deleted."
                />

                <InfoItem
                  icon="wallet-outline"
                  title={`Transaction Fee: ${MESSAGE_FEE_DISPLAY}`}
                  description="A small network fee is charged for each message you send. This fee goes to network validators."
                  iconColor={theme.colors.warning || '#F59E0B'}
                />

                <InfoItem
                  icon="eye-off-outline"
                  title="Metadata is Visible"
                  description="While message content is encrypted, sender/receiver addresses and timestamps are visible on-chain."
                  iconColor={theme.colors.textMuted}
                />
              </View>

              {/* Footer */}
              <TouchableOpacity
                style={[styles.doneButton, { backgroundColor: theme.colors.primary }]}
                onPress={onClose}
                activeOpacity={0.8}
              >
                <Text style={styles.doneButtonText}>Got it</Text>
              </TouchableOpacity>
            </BlurredContainer>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.lg,
    },
    modal: {
      width: '100%',
      maxWidth: 400,
      padding: theme.spacing.lg,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.text,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    content: {
      gap: theme.spacing.md,
    },
    infoItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
    },
    iconContainer: {
      width: 40,
      height: 40,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
    },
    infoContent: {
      flex: 1,
    },
    infoTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    infoDescription: {
      fontSize: 13,
      color: theme.colors.textMuted,
      lineHeight: 18,
    },
    doneButton: {
      marginTop: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    doneButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: 'white',
    },
  });

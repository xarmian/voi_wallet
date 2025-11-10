import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BaseToast, ErrorToast, InfoToast } from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';

export const toastConfig = {
  success: (props: any) => (
    <BaseToast
      {...props}
      style={styles.successToast}
      contentContainerStyle={styles.contentContainer}
      text1Style={styles.text1}
      text2Style={styles.text2}
      text1NumberOfLines={2}
      text2NumberOfLines={3}
      renderLeadingIcon={() => (
        <View style={styles.iconContainer}>
          <Ionicons name="checkmark-circle" size={32} color="#10B981" />
        </View>
      )}
    />
  ),

  error: (props: any) => (
    <ErrorToast
      {...props}
      style={styles.errorToast}
      contentContainerStyle={styles.contentContainer}
      text1Style={styles.text1}
      text2Style={styles.text2}
      text1NumberOfLines={2}
      text2NumberOfLines={3}
      renderLeadingIcon={() => (
        <View style={styles.iconContainer}>
          <Ionicons name="close-circle" size={32} color="#EF4444" />
        </View>
      )}
    />
  ),

  info: (props: any) => (
    <InfoToast
      {...props}
      style={styles.infoToast}
      contentContainerStyle={styles.contentContainer}
      text1Style={styles.text1}
      text2Style={styles.text2}
      text1NumberOfLines={2}
      text2NumberOfLines={3}
      renderLeadingIcon={() => (
        <View style={styles.iconContainer}>
          <Ionicons name="information-circle" size={32} color="#3B82F6" />
        </View>
      )}
    />
  ),

  walletConnectSuccess: ({ text1, text2, props }: any) => (
    <View style={styles.customToast}>
      <View style={styles.customHeader}>
        <Ionicons name="checkmark-circle" size={36} color="#10B981" />
        <Text style={styles.customTitle}>{text1}</Text>
      </View>
      <Text style={styles.customMessage}>{text2}</Text>
      {props?.queueSize > 0 && (
        <View style={styles.queueBadge}>
          <Ionicons name="list" size={16} color="#3B82F6" />
          <Text style={styles.queueText}>
            {props.queueSize} more request{props.queueSize > 1 ? 's' : ''} pending
          </Text>
        </View>
      )}
    </View>
  ),

  walletConnectRejected: ({ text1, text2, props }: any) => (
    <View style={[styles.customToast, styles.rejectedToast]}>
      <View style={styles.customHeader}>
        <Ionicons name="close-circle" size={36} color="#F59E0B" />
        <Text style={styles.customTitle}>{text1}</Text>
      </View>
      <Text style={styles.customMessage}>{text2}</Text>
      {props?.queueSize > 0 && (
        <View style={styles.queueBadge}>
          <Ionicons name="list" size={16} color="#3B82F6" />
          <Text style={styles.queueText}>
            {props.queueSize} more request{props.queueSize > 1 ? 's' : ''} pending
          </Text>
        </View>
      )}
    </View>
  ),
};

const styles = StyleSheet.create({
  successToast: {
    borderLeftColor: '#10B981',
    borderLeftWidth: 6,
    height: 'auto',
    minHeight: 80,
    width: '90%',
    paddingVertical: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  errorToast: {
    borderLeftColor: '#EF4444',
    borderLeftWidth: 6,
    height: 'auto',
    minHeight: 80,
    width: '90%',
    paddingVertical: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  infoToast: {
    borderLeftColor: '#3B82F6',
    borderLeftWidth: 6,
    height: 'auto',
    minHeight: 80,
    width: '90%',
    paddingVertical: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingLeft: 16,
  },
  text1: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 4,
  },
  text2: {
    fontSize: 15,
    fontWeight: '500',
    color: '#4B5563',
    lineHeight: 20,
  },
  customToast: {
    width: '90%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
    borderLeftWidth: 6,
    borderLeftColor: '#10B981',
  },
  rejectedToast: {
    borderLeftColor: '#F59E0B',
  },
  customHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 12,
  },
  customTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
  },
  customMessage: {
    fontSize: 16,
    fontWeight: '500',
    color: '#4B5563',
    lineHeight: 22,
    marginBottom: 8,
  },
  queueBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 8,
    gap: 8,
  },
  queueText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#3B82F6',
  },
});

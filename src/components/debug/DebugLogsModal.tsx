import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Share,
  Alert,
  SafeAreaView,
  Dimensions,
  Platform,
  StatusBar,
} from 'react-native';
import { debugLogger, LogEntry } from '@/services/debug/logger';

interface DebugLogsModalProps {
  visible: boolean;
  onClose: () => void;
}

export const DebugLogsModal: React.FC<DebugLogsModalProps> = ({
  visible,
  onClose,
}) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (visible) {
      // Get initial logs
      setLogs(debugLogger.getLogs());

      // Listen for new logs
      const removeListener = debugLogger.addListener(setLogs);
      return removeListener;
    }
  }, [visible]);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  const getLogColor = (level: 'log' | 'warn' | 'error') => {
    switch (level) {
      case 'error':
        return '#ff4444';
      case 'warn':
        return '#ffaa00';
      default:
        return '#666666';
    }
  };

  const handleShareLogs = async () => {
    try {
      const logText = logs
        .map(log => `[${formatTimestamp(log.timestamp)}] ${log.level.toUpperCase()}: ${log.message}`)
        .join('\n');

      await Share.share({
        message: logText,
        title: 'Ledger Debug Logs',
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to share logs');
    }
  };

  const handleClearLogs = () => {
    Alert.alert(
      'Clear Logs',
      'Are you sure you want to clear all debug logs?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => debugLogger.clearLogs(),
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.modalWrapper}>
        <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Debug Logs</Text>
          <View style={styles.headerButtons}>
            <TouchableOpacity
              style={[styles.button, styles.shareButton]}
              onPress={handleShareLogs}
            >
              <Text style={styles.shareButtonText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.clearButton]}
              onPress={handleClearLogs}
            >
              <Text style={styles.clearButtonText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.closeButton]}
              onPress={onClose}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView
          style={styles.logsContainer}
          contentContainerStyle={styles.logsContent}
          showsVerticalScrollIndicator={true}
        >
          {logs.length === 0 ? (
            <Text style={styles.noLogsText}>
              No debug logs yet. Try connecting to your Ledger device.
            </Text>
          ) : (
            logs.map((log, index) => (
              <View key={index} style={styles.logEntry}>
                <View style={styles.logHeader}>
                  <Text style={styles.timestamp}>
                    {formatTimestamp(log.timestamp)}
                  </Text>
                  <Text
                    style={[
                      styles.level,
                      { color: getLogColor(log.level) },
                    ]}
                  >
                    {log.level.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.message}>{log.message}</Text>
                {log.data && (
                  <Text style={styles.data}>
                    {JSON.stringify(log.data, null, 2)}
                  </Text>
                )}
              </View>
            ))
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Showing {logs.length} log entries
          </Text>
        </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalWrapper: {
    flex: 1,
    backgroundColor: '#ffffff',
    paddingTop: Platform.OS === 'ios' ? 0 : StatusBar.currentHeight || 0,
  },
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    backgroundColor: '#f8f9fa',
    minHeight: 60, // Ensure minimum height for buttons
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333333',
    flex: 1, // Allow title to take available space
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 6,
    flexShrink: 0, // Prevent buttons from shrinking
  },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    minWidth: 60, // Ensure buttons are tappable
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareButton: {
    backgroundColor: '#007AFF',
  },
  shareButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '500',
  },
  clearButton: {
    backgroundColor: '#ff4444',
  },
  clearButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '500',
  },
  closeButton: {
    backgroundColor: '#666666',
  },
  closeButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '500',
  },
  logsContainer: {
    flex: 1,
  },
  logsContent: {
    padding: 16,
  },
  noLogsText: {
    textAlign: 'center',
    color: '#666666',
    fontSize: 16,
    marginTop: 40,
  },
  logEntry: {
    backgroundColor: '#f8f9fa',
    padding: 12,
    marginBottom: 8,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  timestamp: {
    fontSize: 12,
    color: '#666666',
    fontFamily: 'Courier',
  },
  level: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Courier',
  },
  message: {
    fontSize: 14,
    color: '#333333',
    fontFamily: 'Courier',
    lineHeight: 18,
  },
  data: {
    fontSize: 12,
    color: '#666666',
    fontFamily: 'Courier',
    marginTop: 4,
    backgroundColor: '#ffffff',
    padding: 8,
    borderRadius: 4,
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    backgroundColor: '#f8f9fa',
  },
  footerText: {
    textAlign: 'center',
    fontSize: 12,
    color: '#666666',
  },
});
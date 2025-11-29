/**
 * Mobile Alert Adapter
 * Uses React Native Alert for notifications
 */

import { Alert } from 'react-native';
import type { AlertAdapter } from '../types';

export class MobileAlertAdapter implements AlertAdapter {
  alert(title: string, message?: string): void {
    Alert.alert(title, message);
  }
}

// Singleton instance
export const mobileAlert = new MobileAlertAdapter();

/**
 * Extension Alert Adapter
 * Uses browser notifications or console for feedback
 */

import type { AlertAdapter } from '../types';

export class ExtensionAlertAdapter implements AlertAdapter {
  alert(title: string, message?: string): void {
    // In extension popup, we can't use native alerts
    // Log to console and optionally show browser notification
    console.log(`[Alert] ${title}${message ? `: ${message}` : ''}`);

    // Try to show browser notification if permission granted
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body: message });
    }
  }
}

// Singleton instance
export const extensionAlert = new ExtensionAlertAdapter();

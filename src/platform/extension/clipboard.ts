/**
 * Extension Clipboard Adapter
 * Uses navigator.clipboard API for clipboard operations
 */

import type { ClipboardAdapter } from '../types';

export class ExtensionClipboardAdapter implements ClipboardAdapter {
  async setString(text: string): Promise<void> {
    if (!navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }

    await navigator.clipboard.writeText(text);
  }

  async getString(): Promise<string> {
    if (!navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }

    try {
      return await navigator.clipboard.readText();
    } catch (error) {
      // Clipboard read requires user permission and focus
      console.warn('Clipboard read failed:', error);
      return '';
    }
  }
}

// Singleton instance
export const extensionClipboard = new ExtensionClipboardAdapter();

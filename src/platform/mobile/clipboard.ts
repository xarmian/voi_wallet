/**
 * Mobile Clipboard Adapter
 * Uses expo-clipboard for clipboard operations
 */

import * as Clipboard from 'expo-clipboard';
import type { ClipboardAdapter } from '../types';

export class MobileClipboardAdapter implements ClipboardAdapter {
  async setString(text: string): Promise<void> {
    await Clipboard.setStringAsync(text);
  }

  async getString(): Promise<string> {
    const result = await Clipboard.getStringAsync();
    return result || '';
  }
}

// Singleton instance
export const mobileClipboard = new MobileClipboardAdapter();

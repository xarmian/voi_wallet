import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';

/**
 * Copy text to clipboard with user feedback
 * @param text - Text to copy to clipboard
 * @param successMessage - Optional success message to show user
 */
export const copyToClipboard = async (
  text: string,
  successMessage?: string
): Promise<void> => {
  try {
    await Clipboard.setStringAsync(text);
    if (successMessage) {
      Alert.alert('Copied!', successMessage);
    }
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    Alert.alert('Error', 'Failed to copy to clipboard');
  }
};

/**
 * Get text from clipboard
 * @returns Promise that resolves to clipboard text or empty string if failed
 */
export const getFromClipboard = async (): Promise<string> => {
  try {
    return await Clipboard.getStringAsync();
  } catch (error) {
    console.error('Failed to get from clipboard:', error);
    return '';
  }
};

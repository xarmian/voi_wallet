import { clipboard, alert } from '../platform';

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
    await clipboard.setString(text);
    if (successMessage) {
      alert.show('Copied!', successMessage);
    }
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    alert.show('Error', 'Failed to copy to clipboard');
  }
};

/**
 * Get text from clipboard
 * @returns Promise that resolves to clipboard text or empty string if failed
 */
export const getFromClipboard = async (): Promise<string> => {
  try {
    return await clipboard.getString();
  } catch (error) {
    console.error('Failed to get from clipboard:', error);
    return '';
  }
};

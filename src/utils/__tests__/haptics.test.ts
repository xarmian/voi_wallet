import * as Haptics from 'expo-haptics';
import { hapticImpact, hapticNotify, hapticSelection } from '../haptics';

jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
    Error: 'error',
  },
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
}));

// jest-expo defaults Platform.OS to 'ios', so the platform guard is satisfied.

describe('haptics', () => {
  describe('hapticImpact', () => {
    it('defaults to a light impact', () => {
      hapticImpact();
      expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
    });

    it('maps each style to the expo constant', () => {
      hapticImpact('medium');
      expect(Haptics.impactAsync).toHaveBeenCalledWith('medium');
      hapticImpact('heavy');
      expect(Haptics.impactAsync).toHaveBeenCalledWith('heavy');
    });
  });

  describe('hapticNotify', () => {
    it('maps each type to the expo constant', () => {
      hapticNotify('success');
      expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
      hapticNotify('warning');
      expect(Haptics.notificationAsync).toHaveBeenCalledWith('warning');
      hapticNotify('error');
      expect(Haptics.notificationAsync).toHaveBeenCalledWith('error');
    });
  });

  describe('hapticSelection', () => {
    it('triggers a selection tick', () => {
      hapticSelection();
      expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('swallows rejections (fire-and-forget, never throws)', async () => {
    (Haptics.impactAsync as jest.Mock).mockRejectedValueOnce(
      new Error('no haptic engine')
    );
    (Haptics.notificationAsync as jest.Mock).mockRejectedValueOnce(
      new Error('no haptic engine')
    );
    (Haptics.selectionAsync as jest.Mock).mockRejectedValueOnce(
      new Error('no haptic engine')
    );
    expect(() => {
      hapticImpact();
      hapticNotify('error');
      hapticSelection();
    }).not.toThrow();
    // Let the rejected promises settle to prove the .catch() handles them
    // (an unhandled rejection would fail the test run).
    await new Promise((resolve) => setImmediate(resolve));
  });
});

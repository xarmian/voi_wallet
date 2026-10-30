import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import AboutScreen from '../AboutScreen';

const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/account/AccountSelector', () => () => null);
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('expo-updates', () => ({ isEmbeddedLaunch: true }));
jest.mock('expo-application', () => ({ nativeBuildVersion: '1' }));
jest.mock('expo-constants', () => ({ expoConfig: { version: '0.2.0' } }));
jest.mock('@/store/updateStore', () => ({
  useUpdateStore: () => ({ checkForUpdate: jest.fn(), isChecking: false }),
}));

describe('AboutScreen', () => {
  it('shows an accessible back button in the header', async () => {
    const { getByRole } = await render(<AboutScreen />);

    expect(getByRole('button', { name: 'Go back' })).toBeTruthy();
  });

  it('goes back once when the back button is pressed', async () => {
    const { getByRole } = await render(<AboutScreen />);

    expect(mockGoBack).not.toHaveBeenCalled();
    await fireEvent.press(getByRole('button', { name: 'Go back' }));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});

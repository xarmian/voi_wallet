import React from 'react';
import { act, render } from '@testing-library/react-native';
import { setCovered, resetCoverForTests } from '@/utils/lockCover';

jest.mock('expo-camera', () => ({
  CameraView: (props: object) =>
    require('react').createElement(require('react-native').View, {
      ...props,
      testID: 'camera',
    }),
  Camera: {
    requestCameraPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  },
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    require('react').useEffect(callback, [callback]);
  },
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
const mockNavigate = jest.fn();
afterEach(() => {
  resetCoverForTests();
  jest.restoreAllMocks();
});

const mockParse = jest
  .fn()
  .mockResolvedValue({ isAccountData: true, accounts: [{ address: 'test' }] });
const mockClear = jest.fn();
jest.mock('@/utils/accountQRParser', () => ({
  AccountQRParser: {
    parseQRContent: (...args: unknown[]) => mockParse(...args),
  },
  clearAllAccountSecrets: () => mockClear(),
}));
jest.mock('@/store/walletStore', () => ({ useAccounts: () => [] }));
import QRAccountImportScreen from '../QRAccountImportScreen';
const tree = () => (
  <QRAccountImportScreen
    navigation={
      {
        navigate: mockNavigate,
        goBack: jest.fn(),
      } as unknown as React.ComponentProps<
        typeof QRAccountImportScreen
      >['navigation']
    }
    route={{ key: 'test', name: 'QRAccountImport' }}
  />
);
it('DEFECT covered camera is unmounted and resumes on release', async () => {
  setCovered(true);
  const view = await render(tree());
  expect(view.queryByTestId('camera')).toBeNull();
  await act(async () => setCovered(false));
  expect(view.getByTestId('camera')).toBeTruthy();
});
it('DEFECT captured scan ignores same tick cover before parsing and navigates after release', async () => {
  const view = await render(tree());
  const scan = view.getByTestId('camera').props.onBarcodeScanned;
  await act(async () => {
    setCovered(true);
    await scan({ data: 'test' });
  });
  expect(mockParse).not.toHaveBeenCalled();
  expect(mockClear).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  await act(async () => setCovered(false));
  await act(async () => scan({ data: 'test' }));
  expect(mockNavigate).toHaveBeenCalledWith(
    'AccountImportPreview',
    expect.objectContaining({ source: 'qr' })
  );
});
it('DEFECT release resets scanned state after an already completed scan', async () => {
  const view = await render(tree());
  await act(async () =>
    view.getByTestId('camera').props.onBarcodeScanned({ data: 'test' })
  );
  expect(mockNavigate).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('camera').props.onBarcodeScanned).toBeUndefined();
  await act(async () => setCovered(true));
  await act(async () => setCovered(false));
  await act(async () =>
    view.getByTestId('camera').props.onBarcodeScanned({ data: 'test' })
  );
  expect(mockNavigate).toHaveBeenCalledTimes(2);
});

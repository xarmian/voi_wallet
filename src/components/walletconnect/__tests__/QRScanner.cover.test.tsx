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

const mockDeepLink = jest.fn(async () => true);
jest.mock('@/services/deeplink', () => ({
  DeepLinkService: { getInstance: () => ({ testDeepLink: mockDeepLink }) },
}));
jest.mock('@/services/walletconnect/utils', () => ({
  isWalletConnectUri: () => true,
  isVoiUri: () => false,
}));
jest.mock('@/utils/arc0300', () => ({
  parseArc0300AccountImportUri: () => null,
}));
jest.mock('@/utils/clipboard', () => ({ getFromClipboard: jest.fn() }));
jest.mock('@/utils/jsqrLoader', () => ({ jsQR: null }));
import QRScanner from '../QRScanner';
const tree = () => <QRScanner onClose={jest.fn()} />;
it('DEFECT covered camera is unmounted and resumes on release', async () => {
  setCovered(true);
  const view = await render(tree());
  expect(view.queryByTestId('camera')).toBeNull();
  await act(async () => setCovered(false));
  expect(view.getByTestId('camera')).toBeTruthy();
});
it('DEFECT captured native scan ignores same tick cover and scans after release', async () => {
  const view = await render(tree());
  const scan = view.getByTestId('camera').props.onBarcodeScanned;
  await act(async () => {
    setCovered(true);
    await scan({ type: 'qr', data: 'wc:test' });
  });
  expect(mockDeepLink).not.toHaveBeenCalled();
  await act(async () => setCovered(false));
  await act(async () => scan({ type: 'qr', data: 'wc:test' }));
  expect(mockDeepLink).toHaveBeenCalledTimes(1);
});
it('DEFECT release resets scanned and processing state after an already completed scan', async () => {
  const view = await render(tree());
  await act(async () =>
    view
      .getByTestId('camera')
      .props.onBarcodeScanned({ type: 'qr', data: 'wc:test' })
  );
  expect(mockDeepLink).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('camera').props.onBarcodeScanned).toBeUndefined();
  await act(async () => setCovered(true));
  await act(async () => setCovered(false));
  await act(async () =>
    view
      .getByTestId('camera')
      .props.onBarcodeScanned({ type: 'qr', data: 'wc:test' })
  );
  expect(mockDeepLink).toHaveBeenCalledTimes(2);
});

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

const mockCreateDecoder = jest.fn(() => ({}));
const mockIsURFrame = jest.fn().mockReturnValue(false);
const mockProcessFrame = jest.fn();
jest.mock('@/services/remoteSigner/animatedQR', () => ({
  AnimatedQRService: {
    createDecoder: () => mockCreateDecoder(),
    isURFrame: (...args: unknown[]) => mockIsURFrame(...args),
    processFrame: (...args: unknown[]) => mockProcessFrame(...args),
  },
}));

jest.mock('@/components/remoteSigner', () => ({
  AnimatedQRScanner: require('@/components/remoteSigner/AnimatedQRScanner')
    .AnimatedQRScanner,
}));
const mockDecode = jest.fn(() => ({ txns: [] }));
const mockPending = jest.fn();
const mockValidate = jest.fn(() => ({ valid: true }));
jest.mock('@/services/remoteSigner', () => ({
  RemoteSignerService: { decodePayload: () => mockDecode() },
}));
jest.mock('@/types/remoteSigner', () => ({
  isRemoteSignerRequest: () => true,
}));
jest.mock('@/store/remoteSignerStore', () => ({
  useRemoteSignerStore: (
    selector: (state: {
      validateRequest: typeof mockValidate;
      setPendingRequest: typeof mockPending;
    }) => unknown
  ) =>
    selector({ validateRequest: mockValidate, setPendingRequest: mockPending }),
}));
const mockAccounts: never[] = [];
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (
    selector: (state: { wallet: { accounts: never[] } }) => unknown
  ) => selector({ wallet: { accounts: mockAccounts } }),
}));
jest.mock('@/services/wallet/ownKeyCustody', () => ({
  filterOwnKeyAccounts: async () => [],
}));
jest.mock('@/utils/clipboard', () => ({ getFromClipboard: jest.fn() }));
jest.mock('@/utils/jsqrLoader', () => ({ jsQR: null }));
import SignRequestScannerScreen from '../SignRequestScannerScreen';
it('DEFECT covered renders no camera then resumes', async () => {
  setCovered(true);
  const view = await render(<SignRequestScannerScreen />);
  expect(view.queryByTestId('camera')).toBeNull();
  await act(async () => setCovered(false));
  expect(view.getByTestId('camera')).toBeTruthy();
});
it('DEFECT captured camera callback cannot start or navigate while covered and resumes after release', async () => {
  const view = await render(<SignRequestScannerScreen />);
  const scan = view.getByTestId('camera').props.onBarcodeScanned;
  await act(async () => {
    setCovered(true);
    scan({ data: 'test' });
  });
  expect(mockDecode).not.toHaveBeenCalled();
  expect(mockPending).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  await act(async () => setCovered(false));
  await act(async () => scan({ data: 'test' }));
  expect(mockDecode).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledTimes(1);
});

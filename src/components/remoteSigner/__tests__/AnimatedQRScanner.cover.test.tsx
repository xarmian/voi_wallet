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

import { AnimatedQRScanner } from '../AnimatedQRScanner';
const mockScan = jest.fn();
const tree = () => (
  <AnimatedQRScanner onScan={mockScan} autoResetOnFocus={false} />
);
it('DEFECT covered camera is unmounted and resumes on release', async () => {
  setCovered(true);
  const view = await render(tree());
  expect(view.queryByTestId('camera')).toBeNull();
  await act(async () => setCovered(false));
  expect(view.getByTestId('camera')).toBeTruthy();
});
it('DEFECT captured scan ignores same tick cover before touching decoder and scans after release', async () => {
  const view = await render(tree());
  const scan = view.getByTestId('camera').props.onBarcodeScanned;
  await act(async () => {
    setCovered(true);
    scan({ data: 'scan' });
  });
  expect(mockScan).not.toHaveBeenCalled();
  expect(mockIsURFrame).not.toHaveBeenCalled();
  expect(mockProcessFrame).not.toHaveBeenCalled();
  await act(async () => setCovered(false));
  await act(async () => scan({ data: 'scan' }));
  expect(mockScan).toHaveBeenCalledTimes(1);
});
it('DEFECT release resets decoder and completed state even without autoResetOnFocus', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const view = await render(tree());
  expect(mockCreateDecoder).toHaveBeenCalledTimes(1);
  await act(async () =>
    view.getByTestId('camera').props.onBarcodeScanned({ data: 'scan' })
  );
  expect(mockScan).toHaveBeenCalledTimes(1);
  await act(async () => setCovered(true));
  await act(async () => setCovered(false));
  expect(mockCreateDecoder).toHaveBeenCalledTimes(2);
  now += 200;
  await act(async () =>
    view.getByTestId('camera').props.onBarcodeScanned({ data: 'scan' })
  );
  expect(mockScan).toHaveBeenCalledTimes(2);
});

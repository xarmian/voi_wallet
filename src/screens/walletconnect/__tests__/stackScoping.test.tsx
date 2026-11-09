import React, { useEffect } from 'react';
import { scopedNavigation } from '@/services/navigation/scopedNavigation';
import { Alert, View } from 'react-native';
import { act, render, cleanup, waitFor } from '@testing-library/react-native';
import {
  createNavigationContainerRef,
  createNavigatorFactory,
  NavigationContainer,
  StackRouter,
  useNavigationBuilder,
  type ParamListBase,
  type RouteProp,
} from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackNavigatorProps,
} from '@react-navigation/native-stack';

// Headless navigator using the real StackRouter, with every route mounted.
function Nav(props: NativeStackNavigatorProps) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(
    StackRouter,
    props
  );
  return (
    <NavigationContent>
      {state.routes.map((route) => (
        <View key={route.key}>{descriptors[route.key].render()}</View>
      ))}
    </NavigationContent>
  );
}
const Stack = createNavigatorFactory(Nav)();
type Routes = { Main: undefined; TRS: { id: string }; U: { id: string } };
type Navigation = NativeStackNavigationProp<Routes>;

afterEach(async () => {
  await cleanup();
});

it.each([
  'stale',
  'unscoped live',
  'scoped back',
  'scoped replace',
  'scoped top',
] as const)(
  'DEFECT real StackRouter scopes the %s source when A ends under B',
  async (source) => {
    const navs: Record<string, Navigation> = {};
    const Screen = ({
      navigation,
      route,
    }: {
      navigation: Navigation;
      route: RouteProp<ParamListBase>;
    }) => {
      const params = route.params as { id?: string } | undefined;
      const name = `${route.name}:${params?.id ?? ''}`;
      useEffect(() => {
        navs[name] = navigation;
      }, [name, navigation]);
      return <View />;
    };
    const ref = createNavigationContainerRef<Routes>();
    await render(
      <NavigationContainer ref={ref}>
        <Stack.Navigator initialRouteName="Main">
          <Stack.Screen name="Main" component={Screen} />
          <Stack.Screen name="TRS" component={Screen} />
          <Stack.Screen name="U" component={Screen} />
        </Stack.Navigator>
      </NavigationContainer>
    );
    await waitFor(() => expect(navs['Main:']).toBeDefined());
    const names = () =>
      ref.getRootState()!.routes.map((route) => {
        const params = route.params as { id?: string } | undefined;
        return `${route.name}:${params?.id ?? ''}`;
      });
    await act(async () => navs['Main:'].navigate('TRS', { id: 'A' }));
    const stale = navs['TRS:A'];
    await act(async () => stale.replace('U', { id: 'A' }));
    await act(async () => navs['U:A'].navigate('TRS', { id: 'B' }));
    await act(async () => navs['TRS:B'].replace('U', { id: 'B' }));
    expect(names()).toEqual(['Main:', 'U:A', 'U:B']);
    if (source === 'scoped top') {
      await act(async () => navs['U:B'].goBack());
      expect(names()).toEqual(['Main:', 'U:A']);
    }
    await act(async () => {
      if (source === 'stale') stale.goBack();
      else if (source === 'unscoped live') navs['U:A'].goBack();
      else {
        const scoped = scopedNavigation(navs['U:A']);
        if (source === 'scoped replace') scoped.replace('TRS', { id: 'C' });
        else scoped.goBack();
      }
    });
    // Measured hazard: the replaced route's stale source pops the focused B.
    // A live source also needs a target to preserve B.
    expect(names()).toEqual(
      source === 'stale' || source === 'unscoped live'
        ? ['Main:', 'U:A']
        : source === 'scoped replace'
          ? ['Main:', 'TRS:C', 'U:B']
          : source === 'scoped top'
            ? ['Main:']
            : ['Main:', 'U:B']
    );
  }
);

// The production scanner screen on the real router. Only the camera component
// is replaced. A scan that ends after another screen was pushed above it
// removes only the scanner.
import type { RootStackParamList } from '@/navigation/AppNavigator';
import QRScannerScreen from '../QRScannerScreen';

let mockScannerProps: {
  onClose: () => void;
  onSuccess: (uri: string) => Promise<void>;
};
jest.mock('@/components/walletconnect/QRScanner', () => ({
  __esModule: true,
  default: (props: typeof mockScannerProps) => {
    mockScannerProps = props;
    return null;
  },
}));

const beforeRemovePushed = jest.fn();
let scannerNavigation: React.ComponentProps<
  typeof QRScannerScreen
>['navigation'];
function Scanner(props: React.ComponentProps<typeof QRScannerScreen>) {
  useEffect(() => {
    scannerNavigation = props.navigation;
  }, [props.navigation]);
  return <QRScannerScreen {...props} />;
}
function Pushed({
  navigation,
}: {
  navigation: NativeStackNavigationProp<RootStackParamList>;
}) {
  useEffect(
    () => navigation.addListener('beforeRemove', beforeRemovePushed),
    [navigation]
  );
  return <View />;
}

it('real scanner close removes only the scanner under a pushed screen and is idempotent', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const ref = createNavigationContainerRef<RootStackParamList>();
  const AnyStack = Stack as unknown as {
    Navigator: React.ComponentType<{
      initialRouteName: string;
      children: React.ReactNode;
    }>;
    Screen: React.ComponentType<{
      name: string;
      component: React.ComponentType<never>;
    }>;
  };
  await render(
    <NavigationContainer ref={ref as never}>
      <AnyStack.Navigator initialRouteName="Main">
        <AnyStack.Screen name="Main" component={(() => <View />) as never} />
        <AnyStack.Screen name="QRScanner" component={Scanner as never} />
        <AnyStack.Screen name="Pushed" component={Pushed as never} />
      </AnyStack.Navigator>
    </NavigationContainer>
  );
  await waitFor(() => expect(ref.isReady()).toBe(true));
  const names = () => ref.getRootState()!.routes.map((route) => route.name);
  await act(async () =>
    (ref as never as { navigate(n: string): void }).navigate('QRScanner')
  );
  const close = mockScannerProps.onClose;
  const canGoBack = jest.spyOn(scannerNavigation, 'canGoBack');
  await act(async () => mockScannerProps.onSuccess('unrecognized-scan'));
  await act(async () =>
    (ref as never as { navigate(n: string): void }).navigate('Pushed')
  );
  await act(async () => close());
  expect(names()).toEqual(['Main', 'Pushed']);
  await act(async () => close());
  await act(async () => new Promise((done) => setTimeout(done, 120)));
  expect(names()).toEqual(['Main', 'Pushed']);
  expect(beforeRemovePushed).not.toHaveBeenCalled();
  expect(canGoBack).toHaveBeenCalledTimes(1);
});

import { scopedNavigation } from '../scopedNavigation';
import type {
  NavigationAction,
  NavigationState,
} from '@react-navigation/native';

it.each([
  ['back', 'POP', { count: 1 }],
  ['replace', 'REPLACE', { name: 'TRS', params: { id: 'C' } }],
] as const)(
  'DEFECT scoped %s dispatches a thunk targeting its current stack',
  (operation, type, payload) => {
    const actions: NavigationAction[] = [];
    const state = {
      key: 'current-stack',
      routes: [],
    } as unknown as NavigationState;
    const navigation = {
      getState: () => state,
      dispatch: jest.fn((thunk: (state: NavigationState) => NavigationAction) =>
        actions.push(thunk(state))
      ),
      goBack: jest.fn(),
      canGoBack: jest.fn(() => true),
      navigate: jest.fn(),
      replace: jest.fn(),
    };
    const scoped = scopedNavigation(navigation);
    if (operation === 'back') scoped.goBack();
    else scoped.replace('TRS', { id: 'C' });
    expect(actions).toEqual([{ type, payload, target: 'current-stack' }]);
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(scoped.canGoBack()).toBe(true);
    scoped.navigate('Main', { screen: 'Home' });
    expect(navigation.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Home',
    });
  }
);

it.each([true, false])(
  'U6 popOrReplace pops its own route or replaces at root: back=%s',
  (back) => {
    const actions: NavigationAction[] = [];
    const navigation = {
      getState: () => ({ routes: [] }) as unknown as NavigationState,
      dispatch: (thunk: (state: NavigationState) => NavigationAction) =>
        actions.push(thunk({ key: 'stack' } as NavigationState)),
      canGoBack: () => back,
      navigate: jest.fn(),
    };
    const scoped = scopedNavigation(navigation);
    scoped.popOrReplace('Main', { screen: 'Home' });
    expect(actions).toEqual([
      {
        target: 'stack',
        type: back ? 'POP' : 'REPLACE',
        payload: back
          ? { count: 1 }
          : { name: 'Main', params: { screen: 'Home' } },
      },
    ]);
  }
);

it.each(['back', 'replace', 'popOrReplace'] as const)(
  'U7 scoped %s reports whether its calling route still exists',
  (operation) => {
    let present = true;
    const navigation = {
      getState: () =>
        ({
          key: 'stack',
          routes: present ? [{ key: 'A' }] : [],
        }) as unknown as NavigationState,
      dispatch: jest.fn(),
      canGoBack: () => true,
      navigate: jest.fn(),
    };
    const scoped = scopedNavigation(navigation, 'A');
    const call = () =>
      operation === 'back'
        ? scoped.goBack()
        : operation === 'replace'
          ? scoped.replace('TRS')
          : scoped.popOrReplace('Main');
    expect(call()).toBe(true);
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    present = false;
    expect(call()).toBe(false);
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    const unkeyed = scopedNavigation(navigation);
    expect(unkeyed.replace('TRS')).toBe(true);
  }
);

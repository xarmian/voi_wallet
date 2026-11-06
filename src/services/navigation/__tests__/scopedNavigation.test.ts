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
    const state = { key: 'current-stack' } as NavigationState;
    const navigation = {
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

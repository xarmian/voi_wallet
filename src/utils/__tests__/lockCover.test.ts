import { Keyboard, TextInput } from 'react-native';
import {
  isCovered,
  setCovered,
  subscribeCovered,
  resetCoverForTests,
} from '../lockCover';

beforeEach(() => resetCoverForTests());
afterEach(() => {
  resetCoverForTests();
  jest.restoreAllMocks();
});
it('DEFECT defaults false and notifies once per change; same value does nothing', () => {
  const notify = jest.fn();
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  subscribeCovered(notify);
  expect(isCovered()).toBe(false);
  setCovered(false);
  expect(notify).not.toHaveBeenCalled();
  setCovered(true);
  expect(isCovered()).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  setCovered(true);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(dismiss).toHaveBeenCalledTimes(1);
});
it('DEFECT cover up blurs the focused input before notifying; cover down does not blur', () => {
  const input = {} as NonNullable<
    ReturnType<typeof TextInput.State.currentlyFocusedInput>
  >;
  const events: string[] = [];
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {
    events.push('dismiss');
  });
  jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(input);
  const blur = jest
    .spyOn(TextInput.State, 'blurTextInput')
    .mockImplementation((target) => {
      expect(target).toBe(input);
      events.push('blur');
    });
  subscribeCovered(() => {
    expect(isCovered()).toBe(true);
    events.push('notify');
  });
  setCovered(true);
  expect(events).toEqual(['dismiss', 'blur', 'notify']);
  resetCoverForTests();
  setCovered(true);
  blur.mockClear();
  setCovered(false);
  expect(blur).not.toHaveBeenCalled();
});
it('DEFECT throwing keyboard and blur APIs cannot stop notification', () => {
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {
    throw new Error('dismiss');
  });
  jest
    .spyOn(TextInput.State, 'currentlyFocusedInput')
    .mockReturnValue(
      {} as NonNullable<
        ReturnType<typeof TextInput.State.currentlyFocusedInput>
      >
    );
  const blur = jest
    .spyOn(TextInput.State, 'blurTextInput')
    .mockImplementation(() => {
      throw new Error('blur');
    });
  const listener = jest.fn();
  subscribeCovered(listener);
  expect(() => setCovered(true)).not.toThrow();
  expect(blur).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledTimes(1);
});
it('DEFECT missing input API and no focused input are harmless', () => {
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  jest
    .spyOn(TextInput.State, 'currentlyFocusedInput')
    .mockReturnValue(undefined);
  const blur = jest.spyOn(TextInput.State, 'blurTextInput');
  setCovered(true);
  expect(blur).not.toHaveBeenCalled();
  setCovered(false);
  Object.defineProperty(TextInput.State, 'currentlyFocusedInput', {
    configurable: true,
    value: undefined,
  });
  expect(() => setCovered(true)).not.toThrow();
});
it('DEFECT unsubscribe works and notification copies the subscriber set', () => {
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  const second = jest.fn();
  let unsubscribe = () => {};
  subscribeCovered(() => unsubscribe());
  unsubscribe = subscribeCovered(second);
  setCovered(true);
  expect(second).toHaveBeenCalledTimes(1);
  setCovered(false);
  expect(second).toHaveBeenCalledTimes(1);
});

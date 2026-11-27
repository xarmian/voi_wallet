import { AppState, type AppStateStatus } from 'react-native';
import { AppLockSignal } from '@/services/secure/appLockState';
import { lapseEpoch, flowLapsedSince, subscribeFlowLapse } from '../flowLapse';

let appListeners: Set<(state: AppStateStatus) => void>;
const emitAppState = (state: AppStateStatus) =>
  [...appListeners].forEach((cb) => cb(state));

beforeEach(() => {
  appListeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, cb) => {
    appListeners.add(cb);
    return { remove: () => appListeners.delete(cb) };
  });
  AppLockSignal.setUnlocked(true);
});
afterEach(() => {
  AppLockSignal.setUnlocked(false);
  jest.restoreAllMocks();
});

it('an epoch with no lapse since is not lapsed, and no epoch never is', () => {
  const epoch = lapseEpoch();
  expect(flowLapsedSince(epoch)).toBe(false);
  expect(flowLapsedSince(undefined)).toBe(false);
  AppLockSignal.setUnlocked(false);
  expect(flowLapsedSince(undefined)).toBe(false);
});

it('a lock moves the epoch once; a repeated locked notice does not', () => {
  const epoch = lapseEpoch();
  const reasons: string[] = [];
  const stop = subscribeFlowLapse((reason) => reasons.push(reason));
  AppLockSignal.setUnlocked(false);
  expect(flowLapsedSince(epoch)).toBe(true);
  const afterLock = lapseEpoch();
  AppLockSignal.setUnlocked(false);
  expect(flowLapsedSince(afterLock)).toBe(false);
  expect(reasons).toEqual(['lock']);
  stop();
});

it('an unlock does not move the epoch', () => {
  AppLockSignal.setUnlocked(false);
  const epoch = lapseEpoch();
  AppLockSignal.setUnlocked(true);
  expect(flowLapsedSince(epoch)).toBe(false);
});

it('going to the background moves the epoch; becoming active does not', () => {
  const epoch = lapseEpoch();
  emitAppState('inactive');
  emitAppState('active');
  expect(flowLapsedSince(epoch)).toBe(false);
  const reasons: string[] = [];
  const stop = subscribeFlowLapse((reason) => reasons.push(reason));
  emitAppState('background');
  expect(flowLapsedSince(epoch)).toBe(true);
  expect(reasons).toEqual(['background']);
  stop();
});

it('keeps one AppState subscription however many epochs are captured', () => {
  lapseEpoch();
  lapseEpoch();
  lapseEpoch();
  expect(appListeners.size).toBe(1);
});

it('an unsubscribed listener hears nothing, and a throwing one does not stop the others', () => {
  lapseEpoch();
  const heard: string[] = [];
  const stopped = jest.fn();
  const stopFirst = subscribeFlowLapse(stopped);
  const stopThrowing = subscribeFlowLapse(() => {
    throw new Error('listener failed');
  });
  const stopLast = subscribeFlowLapse((reason) => heard.push(reason));
  stopFirst();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  emitAppState('background');
  expect(stopped).not.toHaveBeenCalled();
  expect(heard).toEqual(['background']);
  expect(warn).toHaveBeenCalledTimes(1);
  stopThrowing();
  stopLast();
});

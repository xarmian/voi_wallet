import React from 'react';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RequestCoordinator,
  type RequestRef,
} from '@/services/walletconnect/requestCoordinator';
import { HandledStore } from '@/services/walletconnect/handledStore';
import RequestAgeLabel from '../RequestAgeLabel';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));
const ref: RequestRef = {
  version: 2,
  kind: 'proposal',
  topic: 'age-test',
  id: 1,
};
let coordinator: RequestCoordinator;
let store: HandledStore;
beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  await AsyncStorage.clear();
  store = new HandledStore({ now: () => Date.now() });
  coordinator = new RequestCoordinator({ store, now: () => Date.now() });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  jest.spyOn(HandledStore, 'getInstance').mockReturnValue(store);
});
afterEach(() => {
  coordinator.__resetForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});
it('DEFECT age updates every 30 seconds and clears its interval on unmount', async () => {
  await coordinator.admit(ref);
  const intervalSpy = jest.spyOn(global, 'setInterval');
  const clearSpy = jest.spyOn(global, 'clearInterval');
  const screen = await render(<RequestAgeLabel requestRef={ref} />);
  expect(screen.getByTestId('request-age-label')).toHaveTextContent(
    'Received just now'
  );
  expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
  const interval = intervalSpy.mock.results[0].value;
  await act(async () => jest.advanceTimersByTime(120_000));
  expect(screen.getByTestId('request-age-label')).toHaveTextContent(
    'Received 2 minutes ago'
  );
  await screen.unmount();
  expect(clearSpy).toHaveBeenCalledWith(interval);
});
it('DEFECT sentAtMs describes sent time rather than receipt time', async () => {
  await coordinator.admit(ref);
  const screen = await render(
    <RequestAgeLabel requestRef={ref} sentAtMs={Date.now() - 180_000} />
  );
  expect(screen.getByTestId('request-age-label')).toHaveTextContent(
    'Sent 3 minutes ago'
  );
});
it('REGRESSION unknown ref and unloaded store render nothing', async () => {
  const screen = await render(<RequestAgeLabel requestRef={ref} />);
  expect(screen.queryByTestId('request-age-label')).toBeNull();
  await store.load();
  await screen.rerender(<RequestAgeLabel requestRef={ref} />);
  expect(screen.queryByTestId('request-age-label')).toBeNull();
});
it('DEFECT falls back to durable first seen after coordinator releases the ref', async () => {
  await coordinator.admit(ref);
  coordinator.release(ref);
  const screen = await render(<RequestAgeLabel requestRef={ref} />);
  expect(screen.getByTestId('request-age-label')).toHaveTextContent(
    'Received just now'
  );
});

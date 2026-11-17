import React from 'react';
import { Text } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { useCoverPaused } from '../useCoverPaused';
import { resetCoverForTests, setCovered } from '@/utils/lockCover';
function Probe() {
  const covered = useCoverPaused();
  return <Text>{String(covered)}</Text>;
}
afterEach(() => resetCoverForTests());
it('DEFECT reflects the flag and rerenders on both transitions', async () => {
  const view = await render(<Probe />);
  expect(view.getByText('false')).toBeTruthy();
  await act(async () => setCovered(true));
  expect(view.getByText('true')).toBeTruthy();
  await act(async () => setCovered(false));
  expect(view.getByText('false')).toBeTruthy();
});

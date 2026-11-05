// TASK-504 (DOC-507 5.3): the consent screen. Display and two buttons only.
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import algosdk from 'algosdk';
import ForgottenPinConsent from '../ForgottenPinConsent';

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));

const addr = () => algosdk.generateAccount().addr.toString();
const info = (over: object = {}) =>
  ({
    createdAt: '',
    appVersion: '',
    accountCount: 3,
    accountTypes: {},
    hasFriends: false,
    friendsCount: 0,
    hasRemoteSignerSettings: false,
    restorePlan: { total: 3, addable: 3, addableWithKey: 2, notAdded: [] },
    ...over,
  }) as never;

describe('complete file', () => {
  it('shows the consent text and both buttons; Remove confirms, Cancel cancels', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const view = await render(
      <ForgottenPinConsent
        info={info()}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    expect(
      view.getByText(/^Restore without your PIN\? 3 accounts/)
    ).toBeTruthy();
    await fireEvent.press(view.getByText('Remove old PIN and restore'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await fireEvent.press(view.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('incomplete file', () => {
  const incomplete = info({
    incomplete: {
      leftOut: [
        { address: addr(), label: 'Lost one', reason: 'key-unreadable' },
      ],
    },
  });

  it('names the accounts, and the action stays disabled until REMOVE is typed', async () => {
    const onConfirm = jest.fn();
    const view = await render(
      <ForgottenPinConsent
        info={incomplete}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />
    );
    expect(
      view.getByText(/This backup doesn't have the keys for these 1 accounts/)
    ).toBeTruthy();
    expect(view.getByText(/Lost one \(/)).toBeTruthy();
    await fireEvent.press(view.getByText('Remove old PIN and restore'));
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.changeText(view.getByLabelText('Confirm word'), 'remov');
    await fireEvent.press(view.getByText('Remove old PIN and restore'));
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.changeText(view.getByLabelText('Confirm word'), 'REMOVE');
    await fireEvent.press(view.getByText('Remove old PIN and restore'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Cancel is the default (first) button', async () => {
    const view = await render(
      <ForgottenPinConsent
        info={incomplete}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );
    const tree = JSON.stringify(view.toJSON());
    expect(tree.indexOf('Cancel')).toBeGreaterThan(-1);
    expect(tree.indexOf('Cancel')).toBeLessThan(
      tree.indexOf('Remove old PIN and restore')
    );
  });

  it('on a complete file the action is first', async () => {
    const view = await render(
      <ForgottenPinConsent
        info={info()}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );
    const tree = JSON.stringify(view.toJSON());
    expect(tree.indexOf('Remove old PIN and restore')).toBeLessThan(
      tree.indexOf('Cancel')
    );
  });
});

describe('step unavailable', () => {
  it('a file with no key: the explanation and no action to remove the PIN', async () => {
    const onConfirm = jest.fn();
    const view = await render(
      <ForgottenPinConsent
        info={info({
          restorePlan: {
            total: 2,
            addable: 2,
            addableWithKey: 0,
            notAdded: [],
          },
        })}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />
    );
    expect(view.getByText(/doesn't hold any account keys/)).toBeTruthy();
    expect(view.queryByText('Remove old PIN and restore')).toBeNull();
  });

  it('a file that adds nothing', async () => {
    const view = await render(
      <ForgottenPinConsent
        info={info({
          restorePlan: {
            total: 0,
            addable: 0,
            addableWithKey: 0,
            notAdded: [],
          },
        })}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );
    expect(
      view.getByText(/nothing in this backup that can be added/)
    ).toBeTruthy();
    expect(view.queryByText('Remove old PIN and restore')).toBeNull();
  });
});

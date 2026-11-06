import type { QueueItem, QueueSnapshot } from '../requestQueue';
import { buildWaitingSummary, dappHost } from '../waitingSummary';

jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));

const nowMs = 1_800_000_000_000;
const item = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  ref: { version: 2, kind: 'proposal', topic: 'test-topic', id: 1 },
  kind: 'proposal',
  payload: {},
  dapp: { name: 'Example', url: 'https://example.com/path?query=value' },
  network: 'Voi',
  firstSeenMs: nowMs - 60_000,
  arrivalSeq: 1,
  ...overrides,
});
const snapshot = (
  head: QueueItem | null,
  waiting: QueueItem[] = []
): QueueSnapshot => ({
  head,
  result: null,
  waiting,
  revision: 0,
});

it('describes one proposal with the exact lock-screen strings', () => {
  expect(buildWaitingSummary(snapshot(item()), nowMs)).toEqual({
    count: 1,
    title: 'WalletConnect request waiting',
    dappLine: 'Example · example.com',
    detailLine: 'Voi · Connect',
    ageLine: 'Received 1 minute ago',
    moreLine: null,
  });
});

it('describes one signing request', () => {
  const request = item({
    kind: 'request',
    ref: { version: 2, kind: 'request', topic: 'test-topic', id: 2 },
    sentAtMs: nowMs - 120_000,
  });
  expect(buildWaitingSummary(snapshot(request), nowMs)).toEqual({
    count: 1,
    title: 'WalletConnect request waiting',
    dappLine: 'Example · example.com',
    detailLine: 'Voi · Sign transactions',
    ageLine: 'Sent 2 minutes ago',
    moreLine: null,
  });
});

it('counts head and waiting together and describes the head', () => {
  expect(
    buildWaitingSummary(
      snapshot(item(), [item({ dapp: { name: 'Unknown dApp' } }), item()]),
      nowMs
    )
  ).toEqual({
    count: 3,
    title: '3 WalletConnect requests waiting',
    dappLine: 'Example · example.com',
    detailLine: 'Voi · Connect',
    ageLine: 'Received 1 minute ago',
    moreLine: '2 more',
  });
});

it.each([undefined, '', ' \n\u202e '])(
  'omits an empty or absent network: %p',
  (network) => {
    expect(
      buildWaitingSummary(snapshot(item({ network })), nowMs)?.detailLine
    ).toBe('Connect');
  }
);

it.each([undefined, '', ' \n\u202e '])(
  'uses Unknown dApp for an empty or absent name: %p',
  (name) => {
    expect(
      buildWaitingSummary(
        snapshot(item({ dapp: { name, url: 'https://example.com' } })),
        nowMs
      )?.dappLine
    ).toBe('Unknown dApp · example.com');
  }
);

it('sanitizes hostile names and networks with control and bidi characters', () => {
  const summary = buildWaitingSummary(
    snapshot(
      item({
        dapp: {
          name: '\u202eExample\nWallet\u2066',
          url: 'https://example.com',
        },
        network: '\u202eVoi\nMainnet\u2069',
      })
    ),
    nowMs
  );
  expect(summary?.dappLine).toBe('Example Wallet · example.com');
  expect(summary?.detailLine).toBe('Voi Mainnet · Connect');
  expect(JSON.stringify(summary)).not.toMatch(/[\u202e\u2066\u2069\n]/);
});

it.each([undefined, '', 'invalid url', 'file:///path'])(
  'uses Unknown website for a missing or invalid host: %p',
  (url) => {
    expect(dappHost({ url })).toBe('Unknown website');
    expect(
      buildWaitingSummary(
        snapshot(item({ dapp: { name: 'Example', url } })),
        nowMs
      )?.dappLine
    ).toBe('Example · Unknown website');
  }
);

it('extracts only the hostname and handles missing dapp metadata', () => {
  expect(
    dappHost({
      url: 'https://user:password@example.com:123/path?query=value#fragment',
    })
  ).toBe('example.com');
  expect(dappHost()).toBe('Unknown website');
  expect(
    buildWaitingSummary(snapshot(item({ dapp: undefined })), nowMs)?.dappLine
  ).toBe('Unknown dApp · Unknown website');
});

it('summarizes the first waiting item behind a result without counting the result', () => {
  const pending: QueueSnapshot = {
    ...snapshot(null, [item(), item({ kind: 'request' })]),
    result: { ref: item().ref, title: 'Request ended' },
  };
  expect(buildWaitingSummary(pending, nowMs)).toEqual({
    count: 2,
    title: '2 WalletConnect requests waiting',
    dappLine: 'Example · example.com',
    detailLine: 'Voi · Connect',
    ageLine: 'Received 1 minute ago',
    moreLine: '1 more',
  });
  expect(buildWaitingSummary({ ...pending, waiting: [] }, nowMs)).toBeNull();
  expect(buildWaitingSummary(snapshot(null), nowMs)).toBeNull();
});

it.each([
  [undefined, 'Received 1 minute ago'],
  [null, 'Received 1 minute ago'],
  [NaN, 'Received 1 minute ago'],
  [nowMs - 30_000, 'Sent just now'],
] as const)('uses describeAge for sentAtMs=%p', (sentAtMs, ageLine) => {
  expect(
    buildWaitingSummary(snapshot(item({ sentAtMs })), nowMs)?.ageLine
  ).toBe(ageLine);
});

it('depends only on the supplied time and does not mutate the snapshot', () => {
  const input = snapshot(item());
  Object.freeze(input.head);
  Object.freeze(input.waiting);
  Object.freeze(input);
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
    throw new Error('clock');
  });
  try {
    expect(buildWaitingSummary(input, nowMs + 60_000)?.ageLine).toBe(
      'Received 2 minutes ago'
    );
    expect(buildWaitingSummary(input, nowMs)?.ageLine).toBe(
      'Received 1 minute ago'
    );
    expect(clock).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('excludes payload, identity, icons and all transaction or account details', () => {
  const address = 'A'.repeat(58);
  const payload = {
    address,
    amount: 987654321,
    accountName: 'private-account',
    balance: 87654321,
    asset: 'private-asset',
    recipient: 'private-recipient',
    note: 'private-note',
    pairingUri: 'wc:private-pairing',
    bytes: 'private-bytes',
  };
  const summary = buildWaitingSummary(
    snapshot(
      item({
        payload,
        ref: {
          version: 2,
          kind: 'proposal',
          topic: 'private-topic',
          id: 'private-id',
        },
        dapp: {
          name: 'Example',
          url: 'https://example.com',
          icon: 'https://private-icon.example',
        },
      })
    ),
    nowMs
  );
  const serialized = JSON.stringify(summary);
  for (const value of [
    ...Object.values(payload),
    'private-topic',
    'private-id',
    'private-icon',
  ]) {
    expect(serialized).not.toContain(String(value));
  }
  expect(Object.keys(summary!)).toEqual([
    'count',
    'title',
    'dappLine',
    'detailLine',
    'ageLine',
    'moreLine',
  ]);
});

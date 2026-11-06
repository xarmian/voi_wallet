import {
  describeAge,
  isPastDeadline,
  normalizeExpiryMs,
  resolveDeadline,
  WALLET_MAX_WAIT_MS,
} from '../requestTiming';

it('DEFECT expiry normalizes seconds and milliseconds identically', () => {
  expect(normalizeExpiryMs(1_800_000_000)).toBe(1_800_000_000_000);
  expect(normalizeExpiryMs(1_800_000_000_000)).toBe(1_800_000_000_000);
  expect(normalizeExpiryMs(1e12)).toBe(1e12);
});
it.each([
  0,
  -1,
  NaN,
  Infinity,
  -Infinity,
  '1800000000',
  undefined,
  null,
  {},
  true,
])('REGRESSION invalid expiry is rejected (%#)', (value) => {
  expect(normalizeExpiryMs(value)).toBeNull();
});
it('DEFECT fallback deadline uses firstSeen plus five minutes; dapp expiry takes precedence', () => {
  const firstSeenMs = 1_800_000_000_000;
  expect(WALLET_MAX_WAIT_MS).toBe(300_000);
  expect(resolveDeadline({ firstSeenMs })).toEqual({
    deadlineMs: firstSeenMs + 300_000,
    source: 'wallet',
  });
  expect(resolveDeadline({ firstSeenMs, expiryTimestamp: 'bad' })).toEqual({
    deadlineMs: firstSeenMs + 300_000,
    source: 'wallet',
  });
  expect(
    resolveDeadline({
      firstSeenMs,
      expiryTimestamp: (firstSeenMs + 900_000) / 1000,
    })
  ).toEqual({ deadlineMs: firstSeenMs + 900_000, source: 'dapp' });
});
it('REGRESSION deadline includes the exact boundary', () => {
  expect(isPastDeadline(100, 99)).toBe(false);
  expect(isPastDeadline(100, 100)).toBe(true);
});
it.each([
  [0, 'just now'],
  [59_999, 'just now'],
  [60_000, '1 minute ago'],
  [119_999, '1 minute ago'],
  [120_000, '2 minutes ago'],
  [3_599_999, '59 minutes ago'],
  [3_600_000, '1 hour ago'],
  [7_200_000, '2 hours ago'],
  [86_399_999, '23 hours ago'],
  [86_400_000, '1 day ago'],
  [172_800_000, '2 days ago'],
] as const)('REGRESSION age floors all units (%i)', (age, description) => {
  expect(describeAge({ firstSeenMs: 1000, nowMs: 1000 + age })).toBe(
    `Received ${description}`
  );
  expect(
    describeAge({ firstSeenMs: 0, sentAtMs: 1000, nowMs: 1000 + age })
  ).toBe(`Sent ${description}`);
});
it('REGRESSION only finite sentAt selects Sent and a backwards clock means just now', () => {
  for (const sentAtMs of [undefined, null, NaN, Infinity, -Infinity]) {
    expect(describeAge({ firstSeenMs: 1000, sentAtMs, nowMs: 61_000 })).toBe(
      'Received 1 minute ago'
    );
  }
  expect(describeAge({ firstSeenMs: 2000, nowMs: 1000 })).toBe(
    'Received just now'
  );
  expect(describeAge({ firstSeenMs: 0, sentAtMs: 0, nowMs: 60_000 })).toBe(
    'Sent 1 minute ago'
  );
});

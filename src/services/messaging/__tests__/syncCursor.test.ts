import { computeSyncCursor } from '../syncCursor';

describe('computeSyncCursor', () => {
  describe('advance only on a complete drain', () => {
    it('leaves the cursor untouched when an incremental drain is truncated', () => {
      // The core message-loss guard: a capped/partial drain must NOT advance
      // the durable cursor past rows it never fetched.
      expect(
        computeSyncCursor({
          previous: 1000,
          complete: false,
          isBootstrap: false,
          minFetchedRound: null,
          maxHeldRound: 1200, // held rows jumped ahead, but drain was partial
        })
      ).toBe(1000);
    });

    it('leaves the cursor untouched when a bootstrap is truncated', () => {
      expect(
        computeSyncCursor({
          previous: null,
          complete: false,
          isBootstrap: true,
          minFetchedRound: 900,
          maxHeldRound: 1000,
        })
      ).toBe(null);
    });
  });

  describe('bootstrap (newest-window) fetch', () => {
    it('commits to the oldest round fetched', () => {
      // Everything with round > minFetchedRound is provably in hand.
      expect(
        computeSyncCursor({
          previous: null,
          complete: true,
          isBootstrap: true,
          minFetchedRound: 950,
          maxHeldRound: 1000,
        })
      ).toBe(950);
    });

    it('keeps the previous cursor if nothing was fetched', () => {
      expect(
        computeSyncCursor({
          previous: 500,
          complete: true,
          isBootstrap: true,
          minFetchedRound: null,
          maxHeldRound: null,
        })
      ).toBe(500);
    });

    it('never moves the cursor backwards', () => {
      expect(
        computeSyncCursor({
          previous: 1000,
          complete: true,
          isBootstrap: true,
          minFetchedRound: 950, // older than the existing cursor
          maxHeldRound: 1000,
        })
      ).toBe(1000);
    });
  });

  describe('complete incremental drain', () => {
    it('commits to the newest round held (reached the tip)', () => {
      expect(
        computeSyncCursor({
          previous: 1000,
          complete: true,
          isBootstrap: false,
          minFetchedRound: null,
          maxHeldRound: 1300,
        })
      ).toBe(1300);
    });

    it('sets the first cursor when none existed', () => {
      expect(
        computeSyncCursor({
          previous: null,
          complete: true,
          isBootstrap: false,
          minFetchedRound: null,
          maxHeldRound: 1300,
        })
      ).toBe(1300);
    });

    it('never moves backwards and holds steady when nothing new arrived', () => {
      // Steady-state poll: boundary-overlap re-fetch yields no newer rounds.
      expect(
        computeSyncCursor({
          previous: 1300,
          complete: true,
          isBootstrap: false,
          minFetchedRound: null,
          maxHeldRound: 1300,
        })
      ).toBe(1300);
    });

    it('keeps the previous cursor when no rounds are held', () => {
      expect(
        computeSyncCursor({
          previous: 1300,
          complete: true,
          isBootstrap: false,
          minFetchedRound: null,
          maxHeldRound: null,
        })
      ).toBe(1300);
    });
  });
});

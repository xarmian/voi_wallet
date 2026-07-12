import { computeSyncCursor } from '../syncCursor';

describe('computeSyncCursor', () => {
  describe('advance only on a complete drain from an ingestion-ordered source', () => {
    it('leaves the cursor untouched when a drain is truncated', () => {
      // The core message-loss guard: a capped/partial drain must NOT advance
      // the durable cursor past ingestion ids it never fetched.
      expect(
        computeSyncCursor({ previous: 1000, complete: false, maxId: 5000 })
      ).toBe(1000);
    });

    it('leaves the cursor untouched for a source with no ingestion id (indexer fallback)', () => {
      expect(
        computeSyncCursor({ previous: 1000, complete: true, maxId: null })
      ).toBe(1000);
    });

    it('keeps a null cursor when nothing advanceable is available', () => {
      expect(
        computeSyncCursor({ previous: null, complete: true, maxId: null })
      ).toBe(null);
    });
  });

  describe('complete drain from MIMIR', () => {
    it('advances to the greatest ingestion id fetched', () => {
      expect(
        computeSyncCursor({ previous: 1000, complete: true, maxId: 1300 })
      ).toBe(1300);
    });

    it('sets the first cursor when none existed', () => {
      expect(
        computeSyncCursor({ previous: null, complete: true, maxId: 1300 })
      ).toBe(1300);
    });

    it('never moves backwards', () => {
      expect(
        computeSyncCursor({ previous: 1300, complete: true, maxId: 1200 })
      ).toBe(1300);
    });

    it('holds steady when a steady-state poll fetched nothing newer', () => {
      // maxId falls back to the caller's cursor when no rows were drained.
      expect(
        computeSyncCursor({ previous: 1300, complete: true, maxId: 1300 })
      ).toBe(1300);
    });
  });

  describe('late-indexed row with a lower round but higher id (watermark race)', () => {
    it('advances the cursor to the late row’s higher id so it is not skipped', () => {
      // Cursor had advanced to id 2000 (round 200). A row is then indexed at an
      // earlier round (150) but a higher id (3000); the next drain fetches it
      // and the cursor advances past it.
      expect(
        computeSyncCursor({ previous: 2000, complete: true, maxId: 3000 })
      ).toBe(3000);
    });
  });
});

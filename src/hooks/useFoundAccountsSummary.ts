import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  hasFoundAccountCandidates,
  readFoundAccountsSummary,
  type FoundSummary,
} from '@/services/secure/foundAccounts';

/**
 * TASK-478: the found-accounts summary, read each time the screen gains focus.
 * Reads no key. `error` is set only when the summary failed AND the quarantine
 * registry names an id, so a device with nothing found shows nothing.
 */
export function useFoundAccountsSummary() {
  const [summary, setSummary] = useState<FoundSummary | null>(null);
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      // reload() bumps the generation, which re-runs this read.
      void generation;
      void (async () => {
        try {
          const next = await readFoundAccountsSummary();
          if (!active) return;
          setSummary(next);
          setError(false);
        } catch {
          console.warn('Unable to read the found-accounts summary');
          let candidates = false;
          try {
            candidates = await hasFoundAccountCandidates();
          } catch {
            candidates = true;
          }
          if (!active) return;
          setSummary(null);
          setError(candidates);
        }
      })();
      return () => {
        active = false;
      };
    }, [generation])
  );

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { summary, error, reload };
}

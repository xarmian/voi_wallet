import React, { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import {
  RequestCoordinator,
  type RequestRef,
} from '@/services/walletconnect/requestCoordinator';
import { HandledStore } from '@/services/walletconnect/handledStore';
import { describeAge } from '@/services/walletconnect/requestTiming';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface Props {
  requestRef: RequestRef;
  sentAtMs?: number | null;
}

export default function RequestAgeLabel({ requestRef, sentAtMs }: Props) {
  const styles = useThemedStyles(createStyles);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let mounted = true;
    const interval = setInterval(() => {
      if (mounted) setNowMs(Date.now());
    }, 30_000);
    return () => {
      mounted = false;
      // A review timeout can unmount us inside a timer sweep. Remove the
      // interval after that sweep; the guard stops any intervening tick.
      void Promise.resolve().then(() => clearInterval(interval));
    };
  }, []);

  let firstSeenMs =
    RequestCoordinator.getInstance().describe(requestRef)?.firstSeenMs;
  if (firstSeenMs == null) {
    try {
      firstSeenMs =
        HandledStore.getInstance().firstSeen(requestRef) ?? undefined;
    } catch {
      // The handled store may not have loaded yet; no age is known.
    }
  }
  if (firstSeenMs == null) return null;
  return (
    <Text testID="request-age-label" style={styles.text}>
      {describeAge({ firstSeenMs, sentAtMs, nowMs })}
    </Text>
  );
}
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    text: { color: theme.colors.textMuted, fontSize: 12, marginBottom: 16 },
  });

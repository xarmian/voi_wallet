import React, { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Button,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { RequestCoordinator } from '@/services/walletconnect/requestCoordinator';
import { hostMayDraw } from '@/navigation/lockCoverCondition';
import { useTheme } from '@/contexts/ThemeContext';
import {
  ConnectReview,
  type ConnectParams,
} from '@/screens/walletconnect/SessionProposalScreen';
import { TransactionReview } from '@/screens/wallet/UniversalTransactionSigningScreen';
import {
  findHeadSession,
  getHeadSession,
  headKey,
  type HeadSession,
} from './headSession';
import HostNavigation from './HostNavigation';
import { HOST_DISMISS_LABEL } from './hostCopy';

function HeadBody({ session }: { session: HeadSession }) {
  const params = useSyncExternalStore(
    session.subscribe,
    session.getReviewParams
  );
  useEffect(() => {
    session.markDrawn();
    session.start();
  }, [session]);
  if (session.item.kind === 'proposal') {
    const proposalParams: ConnectParams =
      session.item.ref.version === 1
        ? {
            proposal: undefined,
            sessionRequest: session.item.payload,
            version: 1,
          }
        : { proposal: session.item.payload };
    return <ConnectReview params={proposalParams} binding={session.binding} />;
  }
  return params ? (
    <TransactionReview params={params} binding={session.binding} />
  ) : (
    <ActivityIndicator />
  );
}

/** The OK action: show the next waiting request, or clear the card. */
function dismissResultCard(queue: RequestQueue): void {
  if (queue.getSnapshot().waiting.length > 0) queue.advance();
  else queue.dismissResult();
}

export default function WalletConnectHost() {
  const queue = RequestQueue.getInstance();
  const snapshot = useSyncExternalStore(
    (listener) => queue.subscribe(listener),
    () => queue.getSnapshot()
  );
  const { authState } = useAuth();
  const { theme } = useTheme();
  const mayDraw = hostMayDraw(authState);
  // Where the app stack refuses to draw, a review that was never drawn is not
  // created. One that was drawn is ended as abandoned: unmounting it alone would
  // clear the callbacks its buttons depend on with nothing to register them
  // again, and keeping it mounted would leave a live review nobody can see.
  const session = snapshot.head
    ? mayDraw
      ? getHeadSession(snapshot.head, {
          queue,
          coordinator: RequestCoordinator.getInstance(),
        })
      : findHeadSession(snapshot.head)
    : null;
  // A layout effect, so the session ends and its review hears it before that
  // review's own unmount cleanup removes its listener.
  useLayoutEffect(() => {
    if (!mayDraw && session?.drawn) session.binding.nav.goBack();
  }, [mayDraw, session]);
  const locked = authState.isLocked || !authState.isAuthenticated;
  const showing = mayDraw && (!!snapshot.head || !!snapshot.result);
  // While anything is shown, hardware back must not act on the app stack
  // beneath it. It does what the screen's own back or OK does; under the lock
  // cover it does nothing, as the cover's own handler does.
  useEffect(() => {
    if (!showing) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (locked) return true;
        const current = queue.getSnapshot();
        if (current.result) dismissResultCard(queue);
        else if (current.head)
          findHeadSession(current.head)?.binding.nav.goBack();
        return true;
      }
    );
    return () => subscription.remove();
  }, [showing, locked, queue]);
  if (!mayDraw) return null;
  if (!snapshot.head && !snapshot.result) return null;
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.colors.background },
      ]}
    >
      {session && (
        <HostNavigation key={headKey(session.item.ref)}>
          <HeadBody key={headKey(session.item.ref)} session={session} />
        </HostNavigation>
      )}
      {snapshot.result && (
        <SafeAreaView edges={['top', 'bottom']} style={styles.card}>
          <Text style={{ color: theme.colors.text }}>
            {snapshot.result.title}
          </Text>
          {snapshot.result.message && (
            <Text style={{ color: theme.colors.text }}>
              {snapshot.result.message}
            </Text>
          )}
          <Button
            title={HOST_DISMISS_LABEL}
            onPress={() => dismissResultCard(queue)}
          />
        </SafeAreaView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16 },
});

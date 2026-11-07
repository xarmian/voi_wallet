import React, { useEffect, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Button,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { RequestCoordinator } from '@/services/walletconnect/requestCoordinator';
import { hostMayDraw } from '@/navigation/lockCoverCondition';
import { useTheme } from '@/contexts/ThemeContext';
import { ConnectReview } from '@/screens/walletconnect/SessionProposalScreen';
import { TransactionReview } from '@/screens/wallet/UniversalTransactionSigningScreen';
import type { RootStackParamList } from '@/navigation/AppNavigator';
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
    const proposalParams: RootStackParamList['WalletConnectSessionProposal'] =
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

const styles = StyleSheet.create({ hidden: { display: 'none' } });

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
  // created. One that was drawn stays mounted but hidden: unmounting it would
  // clear the callbacks its buttons depend on, and nothing registers them again.
  const session = snapshot.head
    ? mayDraw
      ? getHeadSession(snapshot.head, {
          queue,
          coordinator: RequestCoordinator.getInstance(),
        })
      : findHeadSession(snapshot.head)
    : null;
  const hiddenSession = !mayDraw && session?.drawn ? session : null;
  if (!mayDraw && !hiddenSession) return null;
  if (!snapshot.head && !snapshot.result) return null;
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: theme.colors.background },
        !mayDraw && styles.hidden,
      ]}
      pointerEvents={mayDraw ? undefined : 'none'}
      accessibilityElementsHidden={!mayDraw}
      importantForAccessibility={mayDraw ? undefined : 'no-hide-descendants'}
    >
      {session && (
        <HostNavigation key={headKey(session.item.ref)}>
          <HeadBody key={headKey(session.item.ref)} session={session} />
        </HostNavigation>
      )}
      {snapshot.result && (
        <View>
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
            onPress={() => {
              if (snapshot.waiting.length > 0) queue.advance();
              else queue.dismissResult();
            }}
          />
        </View>
      )}
    </View>
  );
}

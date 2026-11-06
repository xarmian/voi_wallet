import React, { useEffect, useSyncExternalStore } from 'react';
import { ActivityIndicator, Button, Text, View } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { RequestCoordinator } from '@/services/walletconnect/requestCoordinator';
import { buildWaitingSummary } from '@/services/walletconnect/waitingSummary';
import { ConnectReview } from '@/screens/walletconnect/SessionProposalScreen';
import { TransactionReview } from '@/screens/wallet/UniversalTransactionSigningScreen';
import type { RootStackParamList } from '@/navigation/AppNavigator';
import { getHeadSession, headKey, type HeadSession } from './headSession';
import HostNavigation from './HostNavigation';
import { HOST_DISMISS_LABEL } from './hostCopy';

function HeadBody({ session }: { session: HeadSession }) {
  const params = useSyncExternalStore(
    session.subscribe,
    session.getReviewParams
  );
  useEffect(() => {
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

export default function WalletConnectHost() {
  const queue = RequestQueue.getInstance();
  const snapshot = useSyncExternalStore(
    (listener) => queue.subscribe(listener),
    () => queue.getSnapshot()
  );
  const { authState } = useAuth();
  const locked = authState.isLocked || !authState.isAuthenticated;
  const session = snapshot.head
    ? getHeadSession(snapshot.head, {
        queue,
        coordinator: RequestCoordinator.getInstance(),
      })
    : null;
  // eslint-disable-next-line react-hooks/purity -- the host specification requires the summary age at this render, without persisting time.
  const summary = locked ? buildWaitingSummary(snapshot, Date.now()) : null;
  if (!snapshot.head && !snapshot.result && !snapshot.waiting.length)
    return null;
  return (
    <View>
      {session && (
        <HostNavigation key={headKey(session.item.ref)}>
          <HeadBody key={headKey(session.item.ref)} session={session} />
        </HostNavigation>
      )}
      {summary && (
        <View>
          <Text>{summary.title}</Text>
          <Text>{summary.dappLine}</Text>
          <Text>{summary.detailLine}</Text>
          <Text>{summary.ageLine}</Text>
          {summary.moreLine && <Text>{summary.moreLine}</Text>}
        </View>
      )}
      {snapshot.result && (
        <View>
          <Text>{snapshot.result.title}</Text>
          {snapshot.result.message && <Text>{snapshot.result.message}</Text>}
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

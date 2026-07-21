import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import LockScreen from '@/screens/auth/LockScreen';
import SecureStorageUnavailableScreen from '@/screens/auth/SecureStorageUnavailableScreen';

interface AuthGuardProps {
  children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { authState, recheckAuthState } = useAuth();

  // Fail-closed recovery (TASK-213): when the strict boot reads found secure
  // storage unreadable, render ONLY the recovery screen — no children, no lock
  // screen — so the app grants ZERO wallet access until the check recovers. This
  // takes priority over the normal lock so a broken store never falls through to
  // the PIN pad (which cannot unlock a store it can't read) or to the wallet.
  if (authState.securityUnavailable) {
    return <SecureStorageUnavailableScreen onRetry={recheckAuthState} />;
  }

  const showLock = authState.isLocked || !authState.isAuthenticated;

  // Render both children and lock screen, using visibility to prevent
  // remounting of children (which would reset navigation state)
  return (
    <View style={styles.container}>
      <View style={[styles.content, showLock && styles.hidden]}>
        {children}
      </View>
      {showLock && (
        <View style={styles.lockOverlay}>
          <LockScreen />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  hidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
  },
});

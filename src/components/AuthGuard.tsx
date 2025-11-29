import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import LockScreen from '@/screens/auth/LockScreen';

interface AuthGuardProps {
  children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { authState } = useAuth();

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

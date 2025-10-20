import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import LockScreen from '@/screens/auth/LockScreen';

interface AuthGuardProps {
  children: React.ReactNode;
}

export default function AuthGuard({ children }: AuthGuardProps) {
  const { authState } = useAuth();

  if (authState.isLocked || !authState.isAuthenticated) {
    return <LockScreen />;
  }

  return <>{children}</>;
}

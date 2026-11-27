/**
 * useNotificationsOffer — whether Home offers push notifications (TASK-565).
 *
 * The offer shows while notifications are configured, the platform is not
 * web, the permission is not granted and the user has not dismissed it. It
 * stays hidden until both the permission and the stored dismissal have been
 * read. The permission is read again on focus and when the app returns to the
 * foreground, so turning it on hides the offer.
 *
 * The dismissal is a general-storage flag (not sensitive). Delete Everything
 * removes it with every other non-kept key.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { storage } from '@/platform';
import { notificationService } from '@/services/notifications';
import { isSupabaseConfigured } from '@/services/supabase';

export const NOTIFICATIONS_OFFER_DISMISSED_KEY =
  'voi_notifications_offer_dismissed';

export function useNotificationsOffer(): {
  visible: boolean;
  dismiss: () => void;
} {
  const eligible = isSupabaseConfigured() && Platform.OS !== 'web';
  // null until read.
  const [granted, setGranted] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const mounted = useRef(true);
  const readSeq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const checkPermission = useCallback(() => {
    if (!eligible) return;
    const seq = ++readSeq.current;
    notificationService.getPermissionState().then(
      ({ status }) => {
        // Only the latest read applies.
        if (!mounted.current || seq !== readSeq.current) return;
        setGranted(status === 'granted');
      },
      (error: unknown) => {
        // Keeps the last known state: hidden until a read succeeds.
        console.warn('[NotificationsOffer] Permission read failed:', error);
      }
    );
  }, [eligible]);

  useEffect(() => {
    if (!eligible) return;
    storage.getItem(NOTIFICATIONS_OFFER_DISMISSED_KEY).then(
      (value) => {
        if (!mounted.current) return;
        // A dismiss() before this read resolved wins.
        setDismissed((current) => current === true || value === '1');
      },
      (error: unknown) => {
        console.warn('[NotificationsOffer] Dismissal read failed:', error);
        if (mounted.current) setDismissed((current) => current === true);
      }
    );
  }, [eligible]);

  useFocusEffect(checkPermission);

  useEffect(() => {
    if (!eligible) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkPermission();
    });
    return () => subscription.remove();
  }, [eligible, checkPermission]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    storage
      .setItem(NOTIFICATIONS_OFFER_DISMISSED_KEY, '1')
      .catch((error: unknown) => {
        // Still hidden for this session.
        console.warn('[NotificationsOffer] Dismissal write failed:', error);
      });
  }, []);

  return {
    visible: eligible && granted === false && dismissed === false,
    dismiss,
  };
}

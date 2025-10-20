import {
  LedgerAccountError,
  LedgerAppNotOpenError,
  LedgerDeviceNotConnectedError,
  LedgerUserRejectedError,
} from '@/types/wallet';
import { ledgerTransportService } from '@/services/ledger/transport';

export type LedgerFriendlyErrorCode =
  | 'LEDGER_DEVICE_NOT_CONNECTED'
  | 'LEDGER_APP_NOT_OPEN'
  | 'LEDGER_USER_REJECTED'
  | 'LEDGER_TRANSPORT'
  | 'LEDGER_APP_VERSION_UNSUPPORTED'
  | 'LEDGER_INVALID_REQUEST'
  | 'LEDGER_CONNECTION_FAILED'
  | 'LEDGER_COMMUNICATION_ERROR'
  | 'LEDGER_APP_INFO_ERROR'
  | 'LEDGER_UNKNOWN';

export interface LedgerFriendlyError {
  code: LedgerFriendlyErrorCode;
  message: string;
  retryable: boolean;
  requiresReconnect?: boolean;
  requiresAppOpen?: boolean;
  userAction?: string;
  original?: Error;
  timestamp?: number;
  deviceState?: 'connected' | 'disconnected' | 'unknown';
  attemptCount?: number;
}

export function toLedgerFriendlyError(
  error: unknown,
  ctx?: { attemptCount?: number }
): LedgerFriendlyError {
  const device = ledgerTransportService.getConnectedDevice();
  const deviceState: 'connected' | 'disconnected' | 'unknown' = device
    ? 'connected'
    : ledgerTransportService.getDevices().length > 0
    ? 'disconnected'
    : 'unknown';
  const base = {
    timestamp: Date.now(),
    deviceState,
    attemptCount: ctx?.attemptCount,
  } as const;

  if (error instanceof LedgerDeviceNotConnectedError) {
    return {
      code: 'LEDGER_DEVICE_NOT_CONNECTED',
      message:
        error.message ||
        'Ledger device is not connected. Connect and unlock your Ledger, then open the Algorand app.',
      retryable: true,
      requiresReconnect: true,
      requiresAppOpen: true,
      userAction:
        'Connect and unlock your Ledger, open the Algorand app, then try again.',
      original: error,
      ...base,
    };
  }

  if (error instanceof LedgerAppNotOpenError) {
    return {
      code: 'LEDGER_APP_NOT_OPEN',
      message: error.message || 'Open the Algorand app on your Ledger device.',
      retryable: true,
      requiresAppOpen: true,
      userAction: 'Open the Algorand app on Ledger and try again.',
      original: error,
      ...base,
    };
  }

  if (error instanceof LedgerUserRejectedError) {
    return {
      code: 'LEDGER_USER_REJECTED',
      message: error.message || 'Action rejected on Ledger device.',
      retryable: false,
      userAction: 'Approve on your Ledger to continue, or cancel to abort.',
      original: error,
      ...base,
    };
  }

  if (error instanceof LedgerAccountError) {
    const code = (error as any).code as string | undefined;
    if (code === 'LEDGER_USER_REJECTED') {
      return {
        code: 'LEDGER_USER_REJECTED',
        message: error.message || 'Action rejected on Ledger device.',
        retryable: true,
        userAction: 'Approve on your Ledger to continue, or cancel to abort.',
        original: error,
        ...base,
      };
    }

    const message = (error.message || '').toLowerCase();
    let mappedCode: LedgerFriendlyErrorCode = 'LEDGER_TRANSPORT';
    let retryable = true;
    let userAction: string | undefined;

    if (code === 'LEDGER_APP_VERSION_UNSUPPORTED') {
      mappedCode = 'LEDGER_APP_VERSION_UNSUPPORTED';
      retryable = false;
      userAction = 'Please update the Algorand app on your Ledger device.';
    } else if (code === 'LEDGER_COMMUNICATION_ERROR') {
      mappedCode = 'LEDGER_COMMUNICATION_ERROR';
      retryable = true;
      userAction = 'Check that your Ledger is unlocked and try reconnecting.';
    } else if (code === 'LEDGER_INVALID_APP_INFO' || message.includes('incomplete') || message.includes('app version payload')) {
      mappedCode = 'LEDGER_APP_INFO_ERROR';
      retryable = true;
      userAction = 'Ensure the Algorand app is open on your Ledger and try again. If this persists, try disconnecting and reconnecting your Ledger.';
    } else if (code && code.startsWith('LEDGER_INVALID_')) {
      mappedCode = 'LEDGER_INVALID_REQUEST';
      retryable = false;
    } else if (code && code.startsWith('LEDGER_STATUS_')) {
      mappedCode = 'LEDGER_TRANSPORT';
      retryable = true;
    } else if (
      message.includes('reject') ||
      message.includes('refuse') ||
      message.includes('denied') ||
      message.includes('cancel')
    ) {
      mappedCode = 'LEDGER_USER_REJECTED';
      retryable = false;
      userAction = 'Approve on your Ledger to continue, or cancel to abort.';
    } else if (message.includes('connection') || message.includes('transport')) {
      mappedCode = 'LEDGER_CONNECTION_FAILED';
      retryable = true;
      userAction = 'Try disconnecting and reconnecting your Ledger device.';
    }

    return {
      code: mappedCode,
      message: error.message,
      retryable,
      userAction,
      original: error,
      ...base,
    };
  }

  const unknown = error instanceof Error ? error : new Error(String(error));
  const lower = (unknown.message || '').toLowerCase();

  if (
    lower.includes('reject') ||
    lower.includes('refuse') ||
    lower.includes('denied') ||
    lower.includes('cancel')
  ) {
    return {
      code: 'LEDGER_USER_REJECTED',
      message: unknown.message || 'Action rejected on Ledger device.',
      retryable: false,
      userAction: 'Approve on your Ledger to continue, or cancel to abort.',
      original: unknown,
      ...base,
    };
  }

  return {
    code: 'LEDGER_UNKNOWN',
    message: unknown.message || 'Unknown Ledger error',
    retryable: true,
    original: unknown,
    ...base,
  };
}

export function buildUserFacingLedgerMessage(err: LedgerFriendlyError): string {
  // Compose a concise, user-facing message with troubleshooting hints
  const hint = err.userAction ? ` ${err.userAction}` : '';
  const retryHint = err.retryable && err.attemptCount && err.attemptCount > 1
    ? ` (Attempt ${err.attemptCount})`
    : '';

  // Add specific guidance for common issues
  let troubleshootingTip = '';
  switch (err.code) {
    case 'LEDGER_APP_INFO_ERROR':
      troubleshootingTip = ' Make sure you have the latest Algorand app installed on your Ledger.';
      break;
    case 'LEDGER_CONNECTION_FAILED':
      troubleshootingTip = ' Try using a different USB cable or moving closer to your device for Bluetooth.';
      break;
    case 'LEDGER_COMMUNICATION_ERROR':
      troubleshootingTip = ' Check that no other apps are using your Ledger device.';
      break;
  }

  return `${err.message}${hint}${troubleshootingTip}${retryHint}`.trim();
}

export function getDiagnosticInfo(err: LedgerFriendlyError): Record<string, any> {
  return {
    code: err.code,
    retryable: err.retryable,
    deviceState: err.deviceState,
    timestamp: err.timestamp ? new Date(err.timestamp).toISOString() : undefined,
    attemptCount: err.attemptCount,
    requiresReconnect: err.requiresReconnect,
    requiresAppOpen: err.requiresAppOpen,
    originalMessage: err.original?.message,
  };
}

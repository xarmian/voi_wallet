import { useState } from 'react';
import {
  UnifiedTransactionSigner,
  UnifiedTransactionRequest,
  UnifiedSigningCallbacks,
  UnifiedSigningResult,
} from '@/services/transactions/unifiedSigner';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { LedgerSigningInfo, WalletAccount } from '@/types/wallet';
import { ledgerTransportService, LedgerDeviceInfo } from '@/services/ledger/transport';
import { ledgerAlgorandService, LedgerAlgorandService } from '@/services/ledger/algorand';
import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Authentication states for transaction signing
 */
export type TransactionAuthState =
  | 'idle'
  | 'authenticating'
  | 'signing'
  | 'processing'
  | 'completed'
  | 'error';

/**
 * Ledger status during signing flow
 */
export type LedgerSigningStatus =
  | 'idle'
  | 'searching'
  | 'connecting'
  | 'app_required'
  | 'device_locked'
  | 'ready'
  | 'waiting_confirmation'
  | 'error';

/**
 * Progress information during signing
 */
export interface SigningProgress {
  currentStep: number;
  totalSteps: number;
  message?: string;
}

/**
 * Authentication controller state
 */
export interface TransactionAuthState_Interface {
  // Overall state
  state: TransactionAuthState;
  error: Error | null;

  // Authentication
  requiresPin: boolean;
  requiresBiometric: boolean;
  biometricAvailable: boolean;
  pinAttempts: number;
  maxPinAttempts: number;
  isLocked: boolean;

  // Ledger-specific
  isLedgerFlow: boolean;
  ledgerStatus: LedgerSigningStatus;
  ledgerDevice: LedgerDeviceInfo | null;
  ledgerError: string | null;

  // Progress tracking
  signingProgress: SigningProgress | null;

  // Result
  result: UnifiedSigningResult | null;
}

/**
 * Unified Transaction Authentication Controller
 * Manages the complete authentication and signing flow for ALL transaction types
 */
export class TransactionAuthController {
  private unifiedSigner = UnifiedTransactionSigner.getInstance();
  private stateListeners: Array<(state: TransactionAuthState_Interface) => void> = [];
  private currentState: TransactionAuthState_Interface;
  private currentRequest: UnifiedTransactionRequest | null = null;
  private ledgerSigningInfo: LedgerSigningInfo | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private ledgerCancelRequested: boolean = false;
  private cancelledFlowGeneration: number = 0;
  private activeFlowGeneration: number = 0;
  private hasSubmittedToNetwork: boolean = false;
  private pendingStartAfterReady: boolean = false;
  private pendingPinForStart: string | undefined;
  private hasStartedSigning: boolean = false;
  private ledgerListenersSetup: boolean = false;
  private ledgerVerificationCache: { deviceId: string; timestamp: number; verified: boolean } | null = null;
  private isSigningInProgress: boolean = false;
  private userExplicitlyRejected: boolean = false;
  private signingAbortController: AbortController | null = null;
  private deviceVerificationInProgress: boolean = false;
  private ledgerRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private ledgerRecoveryReason: 'app_required' | 'device_locked' | null = null;
  private lastProgressUpdateTime: number = 0;
  private progressUpdateThrottleMs: number = 300; // Update progress max every 300ms

  constructor() {
    this.currentState = this.getInitialState();
  }

  private getInitialState(): TransactionAuthState_Interface {
    return {
      state: 'idle',
      error: null,
      requiresPin: true,
      requiresBiometric: false,
      biometricAvailable: false,
      pinAttempts: 0,
      maxPinAttempts: 5,
      isLocked: false,
      isLedgerFlow: false,
      ledgerStatus: 'idle',
      ledgerDevice: null,
      ledgerError: null,
      signingProgress: null,
      result: null,
    };
  }

  /**
   * Subscribe to state changes
   */
  public subscribe(listener: (state: TransactionAuthState_Interface) => void): () => void {
    this.stateListeners.push(listener);
    // Return unsubscribe function
    return () => {
      const index = this.stateListeners.indexOf(listener);
      if (index > -1) {
        this.stateListeners.splice(index, 1);
      }
    };
  }

  /**
   * Get current state
   */
  public getState(): TransactionAuthState_Interface {
    return { ...this.currentState };
  }

  /**
   * Update state and notify listeners
   */
  private updateState(updates: Partial<TransactionAuthState_Interface>): void {
    // Prevent any state changes after user has explicitly rejected (except setting error state for rejection)
    if (this.userExplicitlyRejected && updates.state !== 'error' && this.currentState.state === 'error') {
      if (__DEV__) {
        console.log('🚫 BLOCKING state update - user has rejected transaction:', updates);
      }
      return;
    }

    const previous = this.currentState;
    const previousLedgerStatus = previous.ledgerStatus;
    const newState = { ...this.currentState, ...updates };
    const nextLedgerStatus = newState.ledgerStatus;

    // Check if state actually changed to avoid redundant updates
    const stateChanged = previous.state !== newState.state ||
                        previous.ledgerStatus !== newState.ledgerStatus ||
                        previous.ledgerError !== newState.ledgerError ||
                        previous.error !== newState.error ||
                        previous.isLedgerFlow !== newState.isLedgerFlow ||
                        previous.requiresBiometric !== newState.requiresBiometric ||
                        previous.biometricAvailable !== newState.biometricAvailable;

    if (!stateChanged) {
      return;
    }

    this.currentState = newState;
    if (__DEV__) {
      try {
        console.log('TransactionAuthController.updateState', {
          from: { state: previous.state, ledgerStatus: previous.ledgerStatus },
          to: { state: this.currentState.state, ledgerStatus: this.currentState.ledgerStatus },
          error: (updates as any)?.error?.message ?? null,
          ledgerError: updates.ledgerError ?? null,
        });
      } catch {}
    }

    if (previousLedgerStatus !== nextLedgerStatus) {
      this.handleLedgerStatusChange(nextLedgerStatus);
    }

    this.stateListeners.forEach(listener => listener(this.currentState));
  }

  private handleLedgerStatusChange(status: LedgerSigningStatus): void {
    if (!this.currentState.isLedgerFlow) {
      this.cancelLedgerAutoRecovery();
      return;
    }

    if (status === 'app_required' || status === 'device_locked') {
      this.scheduleLedgerAutoRecovery(status);
    } else {
      this.cancelLedgerAutoRecovery();
    }
  }

  /**
   * Check if enough time has passed to allow a progress update (throttling)
   */
  private shouldUpdateProgress(currentIndex: number, total: number): boolean {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastProgressUpdateTime;

    // Always update for first and last transaction
    if (currentIndex === 1 || currentIndex === total) {
      return true;
    }

    // Update every 3 transactions regardless of time
    if (currentIndex % 3 === 0) {
      return true;
    }

    // Or update if enough time has passed
    if (timeSinceLastUpdate >= this.progressUpdateThrottleMs) {
      return true;
    }

    return false;
  }

  private scheduleLedgerAutoRecovery(status: 'app_required' | 'device_locked'): void {
    if (this.ledgerCancelRequested || this.userExplicitlyRejected) {
      return;
    }

    this.ledgerRecoveryReason = status;

    if (this.ledgerRecoveryTimer) {
      return;
    }

    const delay = status === 'device_locked' ? 1000 : 1500;
    this.ledgerRecoveryTimer = setTimeout(() => {
      this.runLedgerAutoRecovery().catch(error => {
        if (__DEV__) {
          console.log('Ledger auto recovery loop error:', error);
        }
      });
    }, delay);
  }

  private cancelLedgerAutoRecovery(): void {
    if (this.ledgerRecoveryTimer) {
      clearTimeout(this.ledgerRecoveryTimer);
      this.ledgerRecoveryTimer = null;
    }
    this.ledgerRecoveryReason = null;
  }

  private async runLedgerAutoRecovery(): Promise<void> {
    this.ledgerRecoveryTimer = null;
    const reason = this.ledgerRecoveryReason;

    if (!reason) {
      return;
    }

    if (
      !this.currentState.isLedgerFlow ||
      this.ledgerCancelRequested ||
      this.userExplicitlyRejected ||
      this.activeFlowGeneration !== this.cancelledFlowGeneration
    ) {
      this.cancelLedgerAutoRecovery();
      return;
    }

    const device = this.currentState.ledgerDevice;
    if (!device) {
      this.scheduleLedgerAutoRecovery(reason);
      return;
    }

    try {
      await this.verifyLedgerDeviceReady(device, { skipIfSigning: true });
      this.updateState({
        ledgerStatus: 'ready',
        ledgerError: null,
      });
      await this.maybeStartSigningIfReady();
    } catch (error) {
      const errorMessage = this.sanitizeLedgerError(error);
      const lower = errorMessage.toLowerCase();

      if (
        lower.includes('device_locked') ||
        lower.includes('locked') ||
        lower.includes('pin') ||
        lower.includes('security status') ||
        lower.includes('0x5515')
      ) {
        if (this.currentState.ledgerStatus !== 'device_locked' || this.currentState.ledgerError !== 'Please unlock your Ledger device and try again') {
          this.updateState({
            state: 'authenticating',
            ledgerStatus: 'device_locked',
            ledgerError: 'Please unlock your Ledger device and try again',
          });
        }
        this.scheduleLedgerAutoRecovery('device_locked');
        return;
      }

      if (
        lower.includes('app_required') ||
        lower.includes('not ready') ||
        lower.includes('app') ||
        lower.includes('bolos') ||
        lower.includes('dashboard')
      ) {
        if (this.currentState.ledgerStatus !== 'app_required' || this.currentState.ledgerError !== 'Please open the Algorand app on your Ledger device') {
          this.updateState({
            state: 'authenticating',
            ledgerStatus: 'app_required',
            ledgerError: 'Please open the Algorand app on your Ledger device',
          });
        }
        this.scheduleLedgerAutoRecovery('app_required');
        return;
      }

      if (lower.includes('communication_error') || lower.includes('not connected')) {
        this.updateState({
          state: 'authenticating',
          ledgerStatus: 'connecting',
          ledgerError: errorMessage,
        });
        this.cancelLedgerAutoRecovery();
        return;
      }

      if (__DEV__) {
        console.log('Ledger auto recovery encountered unexpected error:', errorMessage);
      }
      this.scheduleLedgerAutoRecovery(reason);
    }
  }

  /**
   * Helper to set a safe error without transitioning to a fatal state when it's a user cancel.
   */
  private failIfNotCancelled(error: unknown): void {
    const message = this.sanitizeLedgerError(error);
    if (message.toLowerCase().includes('cancel')) {
      // Soft reset back to authenticating so user can retry without "Transaction Failed"
      this.updateState({
        state: 'authenticating',
        error: null,
        ledgerStatus: this.currentState.isLedgerFlow ? 'searching' : 'idle',
        signingProgress: null,
      });
      return;
    }
    this.updateState({ state: 'error', error: new Error(message) });
  }

  /**
   * Initialize signing flow for a transaction
   */
  public async initializeSigningFlow(request: UnifiedTransactionRequest): Promise<void> {

    this.currentRequest = request;
    this.cancelledFlowGeneration += 1; // invalidate any previous async callbacks
    this.activeFlowGeneration = this.cancelledFlowGeneration;
    this.hasSubmittedToNetwork = false;
    this.pendingStartAfterReady = false;
    this.pendingPinForStart = undefined;
    this.hasStartedSigning = false;
    this.isSigningInProgress = false;
    this.ledgerCancelRequested = false; // Reset cancel flag for new flow
    this.ledgerVerificationCache = null; // Clear cache on new flow
    this.userExplicitlyRejected = false; // Reset rejection flag for new flow
    this.signingAbortController = null; // Clear any previous abort controller
    this.deviceVerificationInProgress = false; // Reset verification semaphore
    this.cancelLedgerAutoRecovery();
    // Only reset necessary fields, don't use getInitialState() which resets isLedgerFlow
    this.updateState({
      state: 'authenticating',
      error: null,
      pinAttempts: 0,
      isLocked: false,
      signingProgress: null,
      result: null,
    });

    try {
      // Determine authentication requirements
      await this.determineAuthRequirements(request.account);

      // Setup Ledger flow if needed
      if (this.currentState.isLedgerFlow) {
        await this.initializeLedgerFlow();
      }

    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.updateState({
        state: 'error',
        error: errorObj,
      });
    }
  }

  /**
   * Determine what type of authentication is required
   */
  private async determineAuthRequirements(account: WalletAccount): Promise<void> {
    try {
      // Check if biometric authentication is available and enabled
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      const biometricAvailable = hasHardware && isEnrolled;

      // Check if this is a Ledger signing flow
      let isLedgerFlow = false;
      let ledgerInfo: LedgerSigningInfo | null = null;

      try {
        const signingInfo = await SecureKeyManager.getSigningInfo(account.address);

        // Try to get Ledger signing info
        if (signingInfo.signingAccountId) {
          ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
            signingInfo.signingAccountId,
            { lookupByAddress: false }
          );
        }

        if (!ledgerInfo && signingInfo.signingAddress) {
          ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
            signingInfo.signingAddress
          );
        }

        if (!ledgerInfo) {
          ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(account.address);
        }

        if (ledgerInfo) {
          isLedgerFlow = true;
          this.ledgerSigningInfo = ledgerInfo;
        }

      } catch (ledgerError) {
        // Ledger info not available, continue with regular flow
      }

      this.updateState({
        requiresPin: true,
        requiresBiometric: biometricAvailable,
        biometricAvailable,
        isLedgerFlow,
        ledgerDevice: isLedgerFlow ? this.getCurrentLedgerDevice() : null,
        ledgerStatus: isLedgerFlow ? 'idle' : 'idle', // Start as idle, will be set to searching when signing starts
      });

    } catch (error) {
      throw new Error(`Failed to determine auth requirements: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Initialize Ledger flow
   */
  private async initializeLedgerFlow(): Promise<void> {
    if (!this.ledgerSigningInfo) return;

    // Always start with searching - don't assume device is ready
    this.updateState({ ledgerStatus: 'searching' });
    this.ledgerCancelRequested = false;

    // Proactively start discovery for both BLE and USB so WalletConnect can pick up devices turning on later
    try {
      await ledgerTransportService.startDiscovery({ ble: true, usb: true });
    } catch {}

    try {
      // Listen for device connection events first
      this.setupLedgerEventListeners();

      // Start connection timeout
      this.startLedgerConnectionTimeout();

      // Check if Ledger device is actually connected AND responsive
      const persistedDevice = this.getCurrentLedgerDevice();
      const connectedDevice =
        persistedDevice && persistedDevice.connected
          ? persistedDevice
          : (() => {
              const active = ledgerTransportService.getConnectedDevice();
              if (active && active.id === this.ledgerSigningInfo!.deviceId) {
                return active;
              }
              return null;
            })();
      let isDeviceReady = false;

      if (connectedDevice && connectedDevice.connected) {
        // Device appears connected, but verify it's actually responsive
        try {
          // Try to verify the device is actually on and has the Algorand app available
          // This will throw if device is off or app isn't open
          await this.verifyLedgerDeviceReady(connectedDevice, { skipIfSigning: true });
          isDeviceReady = true;
        } catch (verifyError) {
          if (__DEV__) {
            console.log('Device connected but not responsive:', verifyError);
          }
          // Device is connected but not ready (likely off or wrong app)
          isDeviceReady = false;
        }
      }

      if (this.ledgerCancelRequested) {
        return; // aborted
      }
      if (isDeviceReady && connectedDevice) {
        this.updateState({
          ledgerDevice: connectedDevice,
          ledgerStatus: 'ready',
        });
        // Stop active discovery once ready
        try { ledgerTransportService.stopDiscovery({ ble: true, usb: true }); } catch {}
        await this.maybeStartSigningIfReady();
      } else {
        // Try to find and connect to the device
        const devices = ledgerTransportService.getDevices();
        const targetDevice = devices.find(d => d.id === this.ledgerSigningInfo!.deviceId);

        if (this.ledgerCancelRequested) {
          return; // aborted
        }
        if (targetDevice) {
          this.updateState({
            ledgerDevice: targetDevice,
            ledgerStatus: 'connecting',
          });

          if (!targetDevice.connected) {
            try {
              await ledgerTransportService.connect(targetDevice.id, {
                transportType: targetDevice.type
              });
              if (this.ledgerCancelRequested) {
                return; // aborted after connect
              }
              // After connecting, verify it's ready using the freshly connected device
              const connectedNow = ledgerTransportService.getConnectedDevice();
              if (!connectedNow) {
                throw new Error('Device not connected');
              }
              await this.verifyLedgerDeviceReady(connectedNow, { skipIfSigning: true });
              this.updateState({ ledgerStatus: 'ready' });
              try { ledgerTransportService.stopDiscovery({ ble: true, usb: true }); } catch {}
              await this.maybeStartSigningIfReady();
            } catch (connectError) {
              const errorMessage = this.sanitizeLedgerError(connectError);
              const lower = errorMessage.toLowerCase();
              
              // Handle specific error types from device verification
              if (lower.includes('device_locked') || lower.includes('locked') || lower.includes('pin') || lower.includes('security status') || lower.includes('0x5515')) {
                this.updateState({
                  state: 'authenticating',
                  ledgerStatus: 'device_locked',
                  ledgerError: 'Please unlock your Ledger device and try again',
                });
                return;
              }
              
              if (lower.includes('app_required') || lower.includes('not ready') || lower.includes('app') || lower.includes('bolos') || lower.includes('dashboard')) {
                this.updateState({
                  state: 'authenticating',
                  ledgerStatus: 'app_required',
                  ledgerError: 'Please open the Algorand app on your Ledger device',
                });
                return;
              }
              
              if (lower.includes('communication_error') || lower.includes('not connected')) {
                this.updateState({
                  state: 'authenticating',
                  ledgerStatus: 'connecting',
                  ledgerError: errorMessage,
                });
                return;
              }
              if (__DEV__) {
                console.error('Ledger connection failed:', errorMessage);
              }
              if (lower.includes('suppressed')) {
                this.updateState({
                  state: 'authenticating',
                  ledgerStatus: 'connecting',
                  ledgerError: 'Waiting before retrying connection...',
                });
                return;
              }
              if (lower.includes('cancel')) {
                // Do not enter error state on cancel; revert to authenticating so retry works
                this.updateState({
                  state: 'authenticating',
                  // Immediately attempt to reconnect again
                  ledgerStatus: 'connecting',
                  ledgerError: null,
                });
                // Kick another connect attempt to keep trying
                try {
                  await ledgerTransportService.connect(targetDevice.id, { transportType: targetDevice.type });
                  const connectedNow = ledgerTransportService.getConnectedDevice();
                  if (connectedNow) {
                    await this.verifyLedgerDeviceReady(connectedNow, { skipIfSigning: true });
                    this.updateState({ ledgerStatus: 'ready' });
                    await this.maybeStartSigningIfReady();
                  }
                } catch {}
                return;
              } else {
                // During pre-submit, never show hard error; keep trying
                this.updateState({
                  state: 'authenticating',
                  ledgerStatus: 'connecting',
                  ledgerError: errorMessage,
                });
              }
            }
          }
        } else {
          // Keep searching; do not show error while waiting
          this.updateState({
            state: 'authenticating',
            ledgerStatus: 'searching',
            ledgerError: 'Ledger device not found. Please ensure it is connected and unlocked.',
          });
        }
      }

    } catch (error) {
      const message = this.sanitizeLedgerError(error);
      if (message.toLowerCase().includes('cancel')) {
        // Return to authenticating on cancel
        this.updateState({
          state: 'authenticating',
          ledgerStatus: 'searching',
          ledgerError: null,
        });
      } else {
        // Keep trying; avoid error while waiting
        this.updateState({
          state: 'authenticating',
          ledgerStatus: 'connecting',
          ledgerError: message,
        });
      }
    }
  }

  /**
   * Verify that a Ledger device is actually ready to sign
   */
  private async verifyLedgerDeviceReady(device: LedgerDeviceInfo, options: { skipIfSigning?: boolean } = {}): Promise<void> {
    if (__DEV__) {
      console.log('🔍 verifyLedgerDeviceReady:', {
        deviceId: device.id,
        skipIfSigning: options.skipIfSigning,
        isSigningInProgress: this.isSigningInProgress,
        shouldSkip: options.skipIfSigning && this.isSigningInProgress
      });
    }

    // Avoid race conditions by skipping verification during active signing
    if (options.skipIfSigning && this.isSigningInProgress) {
      if (__DEV__) {
        console.log('✅ SKIPPING verification - signing in progress');
      }
      return;
    }

    // Also skip if user has explicitly rejected to avoid confusion
    if (this.userExplicitlyRejected) {
      if (__DEV__) {
        console.log('✅ SKIPPING verification - user has rejected transaction');
      }
      return;
    }

    // Skip if the current flow has been cancelled to prevent late callbacks
    if (this.activeFlowGeneration !== this.cancelledFlowGeneration) {
      if (__DEV__) {
        console.log('✅ SKIPPING verification - flow has been cancelled');
      }
      return;
    }

    // Prevent concurrent verification calls using semaphore
    if (this.deviceVerificationInProgress) {
      if (__DEV__) {
        console.log('✅ SKIPPING verification - already in progress');
      }
      return;
    }

    // Check cache first to avoid redundant verification calls
    const now = Date.now();
    const cacheValid = this.ledgerVerificationCache &&
      this.ledgerVerificationCache.deviceId === device.id &&
      (now - this.ledgerVerificationCache.timestamp) < 5000 && // Reduced to 5 second cache
      this.ledgerVerificationCache.verified;

    if (cacheValid) {
      if (__DEV__) {
        console.log('Using cached device verification result');
      }
      return;
    }

    try {
      // Set semaphore to prevent concurrent calls
      this.deviceVerificationInProgress = true;

      if (!device.connected) {
        throw new Error('Device not connected');
      }

      // Use the ledger service to check signing status

      // Check if signing is in progress at the Ledger service level to prevent race conditions
      if (LedgerAlgorandService.isCurrentlySigningTransaction()) {
        if (__DEV__) {
          console.log('✅ SKIPPING device verification - Ledger service is signing transaction');
        }
        return;
      }

      // Try to verify the app - this will throw specific errors for different states
      await ledgerAlgorandService.verifyApp({ requireAppOpen: true });

      // Cache successful verification
      this.ledgerVerificationCache = {
        deviceId: device.id,
        timestamp: now,
        verified: true
      };

      if (__DEV__) {
        console.log('Ledger device verified and ready for signing');
      }

    } catch (error) {
      if (__DEV__) {
        console.log('🚨 Ledger device verification failed during signing!', {
          error: error,
          isSigningInProgress: this.isSigningInProgress,
          currentState: this.currentState.state,
          stack: new Error().stack?.split('\n').slice(1, 6)
        });
      }
      
      // Clear cache on error
      this.ledgerVerificationCache = null;
      
      // Check for specific error types to provide better state management
      const errorMessage = error instanceof Error ? error.message : String(error);
      const lowerMessage = errorMessage.toLowerCase();
      
      if (lowerMessage.includes('locked') || lowerMessage.includes('pin') || lowerMessage.includes('0x5515')) {
        throw new Error('DEVICE_LOCKED');
      }
      
      if (lowerMessage.includes('app') || lowerMessage.includes('not open') || lowerMessage.includes('bolos') || lowerMessage.includes('dashboard')) {
        // Clear cache when wrong app detected to ensure fresh verification next time
        this.ledgerVerificationCache = null;
        throw new Error('APP_REQUIRED');
      }
      
      if (lowerMessage.includes('not connected') || lowerMessage.includes('communication') || lowerMessage.includes('race')) {
        throw new Error('COMMUNICATION_ERROR');
      }
      
      // Generic error
      throw new Error(`Device is not ready: ${errorMessage}`);
    } finally {
      // Always clear the semaphore
      this.deviceVerificationInProgress = false;
    }
  }

  /**
   * Setup Ledger event listeners
   */
  private setupLedgerEventListeners(): void {
    if (this.ledgerListenersSetup) return;
    this.ledgerListenersSetup = true;
    const onConnected = async (device: LedgerDeviceInfo) => {
      if (device.id !== this.ledgerSigningInfo?.deviceId || this.activeFlowGeneration !== this.cancelledFlowGeneration || this.userExplicitlyRejected) {
        return;
      }
      this.clearLedgerConnectionTimeout();
      // Verify actual readiness before advertising 'ready' to UI
      try {
        const connectedNow = ledgerTransportService.getConnectedDevice();
        if (!connectedNow) throw new Error('Device not connected');
        await this.verifyLedgerDeviceReady(connectedNow, { skipIfSigning: true });
        this.updateState({ ledgerDevice: connectedNow, ledgerStatus: 'ready', ledgerError: null });
        await this.maybeStartSigningIfReady();
      } catch (err) {
        const errorMessage = this.sanitizeLedgerError(err);
        const lower = errorMessage.toLowerCase();
        
        if (lower.includes('device_locked') || lower.includes('locked') || lower.includes('pin') || lower.includes('security status') || lower.includes('0x5515')) {
          this.updateState({ ledgerDevice: device, ledgerStatus: 'device_locked', ledgerError: 'Please unlock your Ledger device and try again' });
        } else if (lower.includes('app_required') || lower.includes('not ready') || lower.includes('app') || lower.includes('bolos') || lower.includes('dashboard')) {
          this.updateState({ ledgerDevice: device, ledgerStatus: 'app_required', ledgerError: 'Please open the Algorand app on your Ledger device' });
        } else if (lower.includes('communication_error') || lower.includes('not connected')) {
          this.updateState({ ledgerDevice: device, ledgerStatus: 'connecting', ledgerError: errorMessage });
        } else {
          this.updateState({ ledgerDevice: device, ledgerStatus: 'error', ledgerError: errorMessage });
        }
      }
    };

    const onDisconnected = () => {
      if (!this.currentState.isLedgerFlow) {
        return;
      }
      // During auth/signing before network submit, treat as transient and keep trying
      if ((this.currentState.state === 'authenticating' || this.currentState.state === 'signing') && !this.hasSubmittedToNetwork) {
        this.updateState({
          ledgerDevice: null,
          ledgerStatus: 'connecting',
          ledgerError: 'Ledger device disconnected',
        });
        return;
      }
      // Otherwise show error
      this.updateState({
        ledgerDevice: null,
        ledgerStatus: 'error',
        ledgerError: 'Ledger device disconnected',
      });
    };

    const onDeviceDiscovered = async (info: LedgerDeviceInfo) => {
      if (!this.currentState.isLedgerFlow || this.userExplicitlyRejected || this.activeFlowGeneration !== this.cancelledFlowGeneration) return;
      // If we already have a device or we're not authenticating, ignore
      if (this.currentState.ledgerDevice || this.currentState.state !== 'authenticating') return;

      // If a specific deviceId is known, only react to that one
      if (this.ledgerSigningInfo?.deviceId && info.id !== this.ledgerSigningInfo.deviceId) return;

      // Adopt discovered device and attempt connect
      this.updateState({ ledgerDevice: info, ledgerStatus: 'connecting', ledgerError: null });
      try {
        await ledgerTransportService.connect(info.id, { transportType: info.type });
        const connectedNow = ledgerTransportService.getConnectedDevice();
        if (!connectedNow) throw new Error('Device not connected');
        await this.verifyLedgerDeviceReady(connectedNow, { skipIfSigning: true });
        this.updateState({ ledgerStatus: 'ready' });
        await this.maybeStartSigningIfReady();
      } catch (err) {
        const errorMessage = this.sanitizeLedgerError(err);
        const msg = errorMessage.toLowerCase();
        
        if (msg.includes('device_locked') || msg.includes('locked') || msg.includes('pin') || msg.includes('security status') || msg.includes('0x5515')) {
          this.updateState({ ledgerStatus: 'device_locked', ledgerError: 'Please unlock your Ledger device and try again', state: 'authenticating' });
        } else if (msg.includes('app_required') || msg.includes('not ready') || msg.includes('app') || msg.includes('bolos') || msg.includes('dashboard')) {
          this.updateState({ ledgerStatus: 'app_required', state: 'authenticating', ledgerError: 'Please open the Algorand app on your Ledger device' });
        } else if (msg.includes('communication_error') || msg.includes('not connected')) {
          this.updateState({ ledgerStatus: 'connecting', state: 'authenticating', ledgerError: errorMessage });
        } else if (!msg.includes('cancel')) {
          this.updateState({ ledgerStatus: 'error', state: 'authenticating', ledgerError: errorMessage });
        }
      }
    };

    ledgerTransportService.on('connected', onConnected);
    ledgerTransportService.on('disconnected', onDisconnected);
    ledgerTransportService.on('deviceDiscovered', onDeviceDiscovered);
    // React to device updates (e.g., after unlocking or opening app)
    ledgerTransportService.on('deviceUpdated', async (info) => {
      if (!this.currentState.isLedgerFlow || this.userExplicitlyRejected || this.activeFlowGeneration !== this.cancelledFlowGeneration) return;
      if (this.ledgerSigningInfo?.deviceId && info.id !== this.ledgerSigningInfo.deviceId) return;
      if (this.currentState.ledgerStatus === 'device_locked' || this.currentState.ledgerStatus === 'app_required' || this.currentState.ledgerStatus === 'error') {
        try {
          const connectedNow = ledgerTransportService.getConnectedDevice();
          if (!connectedNow) return;
          await this.verifyLedgerDeviceReady(connectedNow, { skipIfSigning: true });
          this.updateState({ ledgerStatus: 'ready', ledgerError: null });
          await this.maybeStartSigningIfReady();
        } catch {}
      }
    });

    // Store cleanup functions (in a real implementation, you'd want to clean these up)
  }

  /**
   * Get current Ledger device if available (but don't assume it's ready)
   */
  private getCurrentLedgerDevice(): LedgerDeviceInfo | null {
    // Look for known device but don't assume it's connected/ready
    if (this.ledgerSigningInfo) {
      // Check connected device as fallback
      const connectedDevice = ledgerTransportService.getConnectedDevice();
      if (connectedDevice && connectedDevice.id === this.ledgerSigningInfo.deviceId) {
        return connectedDevice;
      }

      const devices = ledgerTransportService.getDevices();
      const knownDevice = devices.find(d => d.id === this.ledgerSigningInfo!.deviceId);

      if (knownDevice) {
        return knownDevice;
      }
    }

    return null;
  }

  /**
   * Start Ledger connection timeout
   */
  private startLedgerConnectionTimeout(): void {
    // Disable hard timeout; continuous retry until user cancels
    this.clearLedgerConnectionTimeout();
  }

  /**
   * Clear Ledger connection timeout
   */
  private clearLedgerConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  /**
   * Authenticate with PIN
   */
  public async authenticateWithPin(pin: string): Promise<boolean> {
    if (this.currentState.isLocked) {
      throw new Error('Authentication is locked due to too many failed attempts');
    }

    try {
      const isValid = await AccountSecureStorage.verifyPin(pin);

      if (isValid) {
        // Reset attempts and proceed with signing
        // If ledger flow, wait until device is ready to start signing
        if (this.currentState.isLedgerFlow && this.currentState.ledgerStatus !== 'ready') {
          this.pendingStartAfterReady = true;
          this.pendingPinForStart = pin;
          // Surface app_required/connecting messaging
          await this.ensureLedgerDeviceReady();
          return true;
        }

        this.updateState({ pinAttempts: 0, state: 'signing' });
        await this.startSigning(pin);
        return true;

      } else {
        // Increment attempts
        const newAttempts = this.currentState.pinAttempts + 1;
        const isLocked = newAttempts >= this.currentState.maxPinAttempts;

        this.updateState({
          pinAttempts: newAttempts,
          isLocked,
          error: new Error(`Incorrect PIN. ${this.currentState.maxPinAttempts - newAttempts} attempts remaining.`),
        });

        if (isLocked) {
          // Lock for 30 seconds
          setTimeout(() => {
            this.updateState({
              isLocked: false,
              pinAttempts: 0,
              error: null,
            });
          }, 30000);
        }

        return false;
      }

    } catch (error) {
      this.updateState({
        state: 'error',
        error: error instanceof Error ? error : new Error('PIN verification failed'),
      });
      return false;
    }
  }

  /**
   * Authenticate with biometrics
   */
  public async authenticateWithBiometrics(): Promise<boolean> {
    if (!this.currentState.biometricAvailable) {
      throw new Error('Biometric authentication not available');
    }

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to sign transaction',
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
        requireConfirmation: false,
      });

      if (result.success) {
        // If ledger flow, wait until device is ready before starting
        if (this.currentState.isLedgerFlow && this.currentState.ledgerStatus !== 'ready') {
          this.pendingStartAfterReady = true;
          this.pendingPinForStart = undefined;
          await this.ensureLedgerDeviceReady();
          return true;
        }
        this.updateState({ state: 'signing' });
        await this.startSigning();
        return true;
      }

      return false;

    } catch (error) {
      this.updateState({
        state: 'error',
        error: error instanceof Error ? error : new Error('Biometric authentication failed'),
      });
      return false;
    }
  }

  /**
   * Start the actual signing process
   */
  private async startSigning(pin?: string): Promise<void> {
    if (!this.currentRequest) {
      throw new Error('No transaction request to sign');
    }

    // Update request with PIN if provided
    if (pin) {
      this.currentRequest.pin = pin;
    }

    try {
      this.isSigningInProgress = true;
      this.signingAbortController = new AbortController(); // Create abort controller for this signing session
      this.lastProgressUpdateTime = 0; // Reset throttle timer for new signing session
      this.updateState({ state: 'signing' });

      const callbacks: UnifiedSigningCallbacks = {
        onSigningStart: () => {
          this.isSigningInProgress = true;
          this.updateState({ state: 'signing' });
        },

        onLedgerPrompt: (ctx) => {
          // Throttle progress updates to reduce re-renders
          if (this.shouldUpdateProgress(ctx.index, ctx.total)) {
            // If we're getting a prompt callback, the device is ready for confirmation
            this.updateState({
              ledgerStatus: 'waiting_confirmation',
              signingProgress: {
                currentStep: ctx.index,
                totalSteps: ctx.total,
                message: `Confirm transaction ${ctx.index} of ${ctx.total} on your Ledger device`,
              },
            });
            this.lastProgressUpdateTime = Date.now();
          }
        },

        onLedgerSigned: (ctx) => {
          // Throttle progress updates to reduce re-renders
          if (this.shouldUpdateProgress(ctx.index, ctx.total)) {
            this.updateState({
              signingProgress: {
                currentStep: ctx.index,
                totalSteps: ctx.total,
                message: `Transaction ${ctx.index} of ${ctx.total} signed`,
              },
            });
            this.lastProgressUpdateTime = Date.now();
          }
        },

        onLedgerRejected: (ctx) => {
          const errorMessage = ctx.error?.message || 'Unknown error';
          const lower = errorMessage.toLowerCase();
          
          // User explicitly rejected - STOP the signing process completely
          if (lower.includes('reject') || lower.includes('denied') || lower.includes('refused') || lower.includes('cancel')) {
            if (__DEV__) {
              console.log('🚫 User explicitly rejected transaction in onLedgerRejected');
            }
            this.isSigningInProgress = false;
            this.userExplicitlyRejected = true;
            this.cancel(); // Full stop
            return;
          }
          
          // Handle specific error types during signing
          if (lower.includes('locked') || lower.includes('pin') || lower.includes('0x5515')) {
            this.updateState({
              state: 'authenticating',
              ledgerStatus: 'device_locked',
              ledgerError: 'Please unlock your Ledger device and try again',
              error: null,
            });
          } else if (lower.includes('race') || lower.includes('pending') || lower.includes('communication')) {
            // Race condition errors during signing - don't change state, let signing continue
            return;
          } else if (lower.includes('app') || lower.includes('not open') || lower.includes('bolos') || lower.includes('dashboard')) {
            this.updateState({
              state: 'authenticating',
              ledgerStatus: 'app_required',
              ledgerError: 'Please open the Algorand app on your Ledger device',
              error: null,
            });
          } else {
            this.updateState({
              state: 'authenticating',
              ledgerStatus: 'error',
              ledgerError: `Transaction rejected on Ledger device: ${errorMessage}`,
              error: null,
            });
          }
        },

        onNetworkSubmit: () => {
          this.hasSubmittedToNetwork = true;
          this.updateState({
            state: 'processing',
            signingProgress: null,
          });
        },

        onNetworkConfirmed: (txId) => {
          this.isSigningInProgress = false;
          this.updateState({
            state: 'completed',
            ledgerStatus: this.currentState.isLedgerFlow ? 'ready' : 'idle',
            result: {
              success: true,
              transactionId: txId,
            },
          });
        },

        onError: (error) => {
          this.isSigningInProgress = false;
          const message = this.sanitizeLedgerError(error);
          const lower = message.toLowerCase();
          if (__DEV__) {
            console.log('🚫 Signing onError', message, { hasSubmitted: this.hasSubmittedToNetwork });
          }

          // User explicitly rejected - STOP completely
          if (lower.includes('rejected') || lower.includes('denied') || lower.includes('refused') || lower.includes('cancel')) {
            if (__DEV__) {
              console.log('🚫 User rejected transaction in onError - calling cancel');
            }
            this.userExplicitlyRejected = true;
            this.cancel();
            return;
          }
          
          if (this.hasSubmittedToNetwork) {
            this.updateState({ state: 'error', error: error instanceof Error ? error : new Error(String(error)) });
          } else {
            // Handle specific error types during signing
            if (lower.includes('locked') || lower.includes('pin') || lower.includes('0x5515')) {
              this.updateState({
                state: 'authenticating',
                ledgerStatus: 'device_locked',
                ledgerError: 'Please unlock your Ledger device and try again',
                error: null,
              });
            } else if (lower.includes('race') || lower.includes('pending') || lower.includes('communication')) {
              // Race condition errors during signing - don't change state, let signing retry
              return;
            } else if (lower.includes('app') || lower.includes('not open') || lower.includes('bolos') || lower.includes('dashboard')) {
              this.updateState({
                state: 'authenticating',
                ledgerStatus: 'app_required',
                ledgerError: 'Please open the Algorand app on your Ledger device',
                error: null,
              });
            } else {
              this.updateState({
                state: 'authenticating',
                ledgerStatus: 'error',
                ledgerError: message,
                error: null,
              });
            }
          }
        },

        onComplete: (result) => {
          this.isSigningInProgress = false;
          if (__DEV__) {
            console.log('Signing onComplete', { success: result.success, hasSubmitted: this.hasSubmittedToNetwork });
          }
          if (!result.success && !this.hasSubmittedToNetwork) {
            this.updateState({
              state: 'authenticating',
              ledgerStatus: 'error',
              ledgerError: result.error?.message || 'Signing failed before submission',
              result,
              error: null,
            });
            return;
          }
          this.updateState({
            result,
            state: result.success ? 'completed' : 'error',
            ledgerStatus: this.currentState.isLedgerFlow && result.success ? 'ready' : this.currentState.ledgerStatus, // Fix final state
            error: result.error || null,
          });
        },
      };

      // Execute the signing
      const result = await this.unifiedSigner.signTransaction(this.currentRequest, callbacks);

    } catch (error) {
      this.isSigningInProgress = false;
      const message = this.sanitizeLedgerError(error);
      const lower = message.toLowerCase();

      const prepareForRetry = async (
        status: LedgerSigningStatus,
        ledgerError: string,
        options: { restartDiscovery?: boolean } = {}
      ) => {
        if (this.ledgerCancelRequested || this.userExplicitlyRejected) {
          return;
        }
        // Allow the flow to resume once the device becomes ready again
        this.pendingStartAfterReady = true;
        this.pendingPinForStart = this.currentRequest?.pin ?? this.pendingPinForStart;
        this.hasStartedSigning = false;

        const shouldRestartDiscovery =
          status === 'connecting' || options.restartDiscovery === true;

        if (shouldRestartDiscovery) {
          // Ensure discovery continues so we detect the Ledger coming back online
          void ledgerTransportService
            .startDiscovery({ ble: true, usb: true })
            .catch((startError) => {
              if (__DEV__) {
                console.warn('Failed to (re)start Ledger discovery during retry preparation', startError);
              }
            });
        }

        this.updateState({
          state: 'authenticating',
          ledgerStatus: status,
          ledgerError,
          error: null,
        });

        if (options.restartDiscovery) {
          void this.initializeLedgerFlow().catch((initError) => {
            if (__DEV__) {
              console.error('Failed to restart Ledger discovery after signing error', initError);
            }
          });
        }

        await this.ensureLedgerDeviceReady();
      };

      if (
        lower.includes('cancel') ||
        lower.includes('reject') ||
        lower.includes('denied') ||
        lower.includes('refused')
      ) {
        // User cancelled during signing; return to authenticating so they can retry
        this.updateState({
          state: 'authenticating',
          ledgerStatus: this.currentState.isLedgerFlow ? 'searching' : 'idle',
          ledgerError: null,
        });
        return;
      }

      if (
        lower.includes('device_locked') ||
        lower.includes('locked') ||
        lower.includes('unlock') ||
        lower.includes('0x5515')
      ) {
        await prepareForRetry('device_locked', 'Please unlock your Ledger device and try again');
        return;
      }

      if (
        lower.includes('app_required') ||
        lower.includes('not ready') ||
        lower.includes('app') ||
        lower.includes('bolos') ||
        lower.includes('dashboard')
      ) {
        await prepareForRetry('app_required', 'Please open the Algorand app on your Ledger device');
        return;
      }

      if (
        lower.includes('communication') ||
        lower.includes('not connected') ||
        lower.includes('not found') ||
        lower.includes('disconnected')
      ) {
        await prepareForRetry('connecting', message, { restartDiscovery: true });
        return;
      }

      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.updateState({
        state: 'error',
        error: errorObj,
      });
    }
  }

  /**
   * If Ledger is ready and we have a pending start (or this is a Ledger flow without PIN requirement), start signing once.
   */
  private async maybeStartSigningIfReady(): Promise<void> {
    if (!this.currentState.isLedgerFlow) return;
    if (this.currentState.ledgerStatus !== 'ready') return;
    if (this.hasStartedSigning) return;
    
    // CRITICAL: Don't restart signing if user cancelled or rejected
    if (this.ledgerCancelRequested || this.userExplicitlyRejected) {
      return;
    }

    // Don't restart if flow generation has been cancelled
    if (this.activeFlowGeneration !== this.cancelledFlowGeneration) {
      return;
    }

    // Prefer pending pin if set; otherwise proceed without pin
    const pin = this.pendingPinForStart;
    this.pendingStartAfterReady = false;
    this.pendingPinForStart = undefined;
    this.hasStartedSigning = true;
    
    await this.startSigning(pin);
  }

  /**
   * Ensure the current Ledger device (if any) is ready. Safe against null device.
   */
  private async ensureLedgerDeviceReady(): Promise<void> {
    const device = this.currentState.ledgerDevice;
    if (!device || this.userExplicitlyRejected || this.activeFlowGeneration !== this.cancelledFlowGeneration) {
      return;
    }

    try {
      await this.verifyLedgerDeviceReady(device, { skipIfSigning: true });
      this.updateState({ ledgerStatus: 'ready', ledgerError: null });
      await this.maybeStartSigningIfReady();
    } catch (err) {
      const errorMessage = this.sanitizeLedgerError(err);
      const lower = errorMessage.toLowerCase();
      
      if (lower.includes('device_locked') || lower.includes('locked') || lower.includes('pin') || lower.includes('security status') || lower.includes('0x5515')) {
        this.updateState({
          state: 'authenticating',
          ledgerStatus: 'device_locked',
          ledgerError: 'Please unlock your Ledger device and try again',
        });
      } else if (lower.includes('app_required') || lower.includes('not ready') || lower.includes('app') || lower.includes('bolos') || lower.includes('dashboard')) {
        this.updateState({
          state: 'authenticating',
          ledgerStatus: 'app_required',
          ledgerError: 'Please open the Algorand app on your Ledger device',
        });
      } else if (lower.includes('communication_error') || lower.includes('not connected')) {
        this.updateState({
          state: 'authenticating',
          ledgerStatus: 'connecting',
          ledgerError: errorMessage,
        });
        this.pendingStartAfterReady = true;
        this.hasStartedSigning = false;
      } else {
        this.updateState({
          state: 'authenticating',
          ledgerStatus: 'error',
          ledgerError: errorMessage,
        });
      }
    }
  }

  /**
   * Cancel the current signing process
   */
  public cancel(): void {
    this.clearLedgerConnectionTimeout();
    this.ledgerCancelRequested = true;
    this.isSigningInProgress = false;
    this.ledgerVerificationCache = null; // Clear cache on cancel
    this.cancelLedgerAutoRecovery();
    try {
      ledgerTransportService.stopDiscovery({ ble: true, usb: true });
    } catch (stopError) {
      if (__DEV__) {
        console.warn('Failed to stop Ledger discovery on cancel', stopError);
      }
    }

    // Abort any active signing process
    if (this.signingAbortController) {
      this.signingAbortController.abort();
      this.signingAbortController = null;
    }

    // invalidate current flow; any late async callbacks will be ignored
    this.cancelledFlowGeneration += 1;
    try {
      ledgerTransportService.cancelConnect();
    } catch {}
    this.currentRequest = null;
    this.ledgerSigningInfo = null;

    // If user explicitly rejected, don't reset to idle state to prevent restart
    if (this.userExplicitlyRejected) {
      this.updateState({
        ...this.getInitialState(),
        state: 'error',
        error: new Error('Transaction cancelled by user')
      });
    } else {
      this.updateState(this.getInitialState());
    }
  }

  /**
   * Reset controller state after the modal has been dismissed.
   * Ensures subsequent transactions can start fresh even after an error.
   */
  public resetAfterDismiss(): void {
    this.clearLedgerConnectionTimeout();
    this.ledgerCancelRequested = false;
    this.userExplicitlyRejected = false;
    this.isSigningInProgress = false;
    this.pendingStartAfterReady = false;
    this.pendingPinForStart = undefined;
    this.hasStartedSigning = false;
    this.hasSubmittedToNetwork = false;
    this.ledgerVerificationCache = null;
    this.deviceVerificationInProgress = false;
    this.cancelLedgerAutoRecovery();
    try {
      ledgerTransportService.stopDiscovery({ ble: true, usb: true });
    } catch (stopError) {
      if (__DEV__) {
        console.warn('Failed to stop Ledger discovery during reset', stopError);
      }
    }

    if (this.signingAbortController) {
      this.signingAbortController.abort();
      this.signingAbortController = null;
    }

    this.currentRequest = null;
    this.ledgerSigningInfo = null;
    this.connectingDeviceId = null;

    // Invalidate any in-flight callbacks
    this.cancelledFlowGeneration += 1;
    this.activeFlowGeneration = this.cancelledFlowGeneration;

    // Reset state back to idle and notify listeners
    const initialState = this.getInitialState();
    this.updateState(initialState);
  }

  /**
   * Retry Ledger connection
   */
  public async retryLedgerConnection(): Promise<void> {
    if (!this.currentState.isLedgerFlow) return;

    this.updateState({
      ledgerStatus: 'searching',
      ledgerError: null,
    });

    await this.initializeLedgerFlow();
  }

  /**
   * Sanitize Ledger connection errors to prevent BLE crashes
   */
  private sanitizeLedgerError(error: unknown): string {
    if (!error) {
      return 'Unknown connection error occurred';
    }

    if (typeof error === 'string') {
      return error || 'Connection failed';
    }

    if (error instanceof Error) {
      const message = error.message || 'Connection failed';
      const lower = message.toLowerCase();

      if (
        lower.includes('transaction rejected') ||
        lower.includes('action rejected') ||
        lower.includes('user rejected') ||
        lower.includes('user denied')
      ) {
        return 'Transaction cancelled by user';
      }

      if (lower.includes('timeout')) {
        return 'Connection timeout. Please ensure your Ledger device is unlocked and the Algorand app is open.';
      }
      if (lower.includes('ble')) {
        return 'Bluetooth connection failed. Please ensure your Ledger device is connected and unlocked.';
      }
      if (lower.includes('not found') || lower.includes('not connected')) {
        return 'Ledger device not connected. Please connect your device and try again.';
      }

      return message;
    }

    // Fallback for any other error types
    try {
      return JSON.stringify(error);
    } catch {
      return 'Failed to connect to Ledger device. Please check your connection and try again.';
    }
  }

  /**
   * Clean up resources
   */
  public cleanup(): void {
    this.clearLedgerConnectionTimeout();

    // Abort any active signing process
    if (this.signingAbortController) {
      this.signingAbortController.abort();
      this.signingAbortController = null;
    }

    this.stateListeners.length = 0;
    this.currentRequest = null;
    this.ledgerSigningInfo = null;
    this.userExplicitlyRejected = false;
  }
}

// Export hook for React components to use the controller
export const useTransactionAuthController = () => {
  const [controller] = useState(() => new TransactionAuthController());
  return controller;
};

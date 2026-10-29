# TASK-437 validation record

Review access covers queued requests across dApps. It expires after 60 seconds
without touch activity, when the queue empties, on background, on re-lock or
credential rotation, and on leaving/cancelling the flow. Each request requires
its own Sign tap. Authentication never unlocks Main or runs wallet migrations.
PIN/passphrase verification reuses the existing persisted wallet throttle;
opening another request does not reset it.
TASK-438 owns the connection proposal account/address gate.

The locked screen mounts only dApp metadata, the website host, network and auth /
reject controls. The loading route exposes no transaction data. Request deep
links only wake the app; there is no local WalletConnect request notification
containing transaction details. Existing success/rejection toasts are generic.

SDK 58 verification: the installed expo-secure-store 58.0.2 types include
requireConfirmation (contrary to the analysis brief), as do the current official
[SecureStore docs](https://docs.expo.dev/versions/latest/sdk/securestore/).
Both SecureStore and LocalAuthentication request confirmation on Android.
The OS can ignore this hint; do not rely on it as a security boundary.

Automated negative controls were run on base `bb8e945` before implementation:
the locked review
rendered `12.5 VOI`, opening the signing modal invoked biometrics, the controller
ignored the summary and requested no Android confirmation, and real biometric
unlock left SessionKeyVault unlocked after locked signing.

Additional controls failed before their fixes: PIN and biometric unlock could
complete globally after WalletConnect took focus, an explicit re-lock could
leave review valid until vault teardown, and automatic queue advancement could
restart the idle clock. LockScreen now checks navigation focus before prompting
and before accepting an auth result. The grant observes re-lock synchronously;
automatic queue advancement preserves the existing deadline.

## Device checks still required

No physical iOS/Android device is available in this environment; no device result
or screenshot is claimed. Capture these for the director before release:

- iOS Face ID; Touch ID or passcode; Android fingerprint and strong face if available.
- Locked and unlocked, PIN and biometrics: foreground request, cold WC deep link,
  background receipt, background during review, and queued requests across dApps.
- Before auth: no amount, address, asset, note or account label in UI, accessibility
  or app-switcher snapshot. Reject without auth leaves the wallet locked.
- After auth: review details, then Sign without another auth prompt; queue drain,
  cancel, back/swipe, 60-second idle and background all drop review keys.
- Verify Face ID prompt text visibility and whether Android face SecureStore
  requests honor confirmation. Verify fallback after biometric cancellation or
  enrollment invalidation, and passphrase wallets.

## Automated results

- `npm ci --no-audit --no-fund`: passed without an .env.
- `npx tsc --noEmit`: passed.
- `npm run lint`: passed, 0 errors and 151 warnings (baseline/ceiling lowered from 153).
- `npx jest --runInBand`: 198 suites and 2,906 tests passed.
- `npm run lint:baseline:check`: passed; generated artifact and lint ceiling match.

Heavy checks ran under `/tmp/heavy.lock`. No device validation is implied by
these automated results.

## Changed files

- `TASK-437-validation.md`
- `lint-baseline.json`
- `package.json`
- `src/components/UnifiedAuthModal.tsx`
- `src/components/UnifiedTransactionAuthModal.tsx`
- `src/components/__tests__/UnifiedTransactionAuthModal.initOnce.test.tsx`
- `src/components/remoteSigner/SignerAuthModal.tsx`
- `src/components/walletconnect/LockedRequestGate.tsx`
- `src/contexts/AuthContext.tsx`
- `src/contexts/__tests__/AuthContext.test.tsx`
- `src/navigation/AppNavigator.tsx`
- `src/navigation/__tests__/serviceBootstrapWcDelivery.test.ts`
- `src/platform/mobile/__tests__/secureStorageFailClosed.test.ts`
- `src/platform/mobile/secureStorage.ts`
- `src/screens/auth/LockScreen.tsx`
- `src/screens/wallet/UniversalTransactionSigningScreen.tsx`
- `src/screens/wallet/__tests__/UniversalTransactionSigningScreen.test.tsx`
- `src/screens/walletconnect/TransactionRequestScreen.tsx`
- `src/screens/walletconnect/__tests__/TransactionRequestScreen.answerFailure.test.tsx`
- `src/services/auth/__tests__/reviewGrant.test.ts`
- `src/services/auth/__tests__/transactionAuthController.biometricGate.test.ts`
- `src/services/auth/reviewGrant.ts`
- `src/services/auth/transactionAuthController.ts`
- `src/services/secure/SessionKeyVault.ts`
- `src/services/secure/__tests__/pinThrottle.test.ts`
- `src/services/secure/appLockState.ts`
- `src/services/transactions/unifiedSigner.ts`
- `src/utils/__tests__/signingSummary.test.ts`
- `src/utils/signingSummary.ts`

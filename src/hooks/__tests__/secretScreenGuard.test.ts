/**
 * TASK-493: population guard for secret screens.
 *
 * Any screen or component that renders a recovery phrase, a private key, a key
 * QR or an export of one must call useSecureScreen(), which blocks screen
 * capture AND keeps the screen out of the iOS app-switcher snapshot (one call
 * covers both, so a screen cannot take one and miss the other).
 *
 * The scan is by source text over src/screens and src/components. A new file
 * that reveals or renders secret material fails here until it either calls
 * useSecureScreen() or is added to NOT_SECRET with a reason a reviewer accepts.
 */
import fs from 'fs';
import path from 'path';

const srcRoot = path.resolve(__dirname, '../..');

const SECRET_RENDER =
  /\b(revealMnemonic|revealPrivateKey|generateArc0300AccountExportUri)\s*\(|<(MnemonicDisplay|MnemonicBackupFlow|MnemonicVerification|AnimatedQRCode|QRCode)\b/;

// Files that match SECRET_RENDER but show no secret, with the reason.
const NOT_SECRET: Record<string, string> = {
  'components/UnifiedTransactionAuthModal.tsx':
    'QR carries an unsigned transaction signing request, no key',
  'components/rekey/AirgapVerificationFlow.tsx':
    'QR carries an unsigned rekey verification request, no key',
  'screens/wallet/ReceiveScreen.tsx': 'QR of the public address',
  'components/remoteSigner/AnimatedQRCode.tsx':
    'rendering primitive; every host that feeds it a payload is checked here',
};

// Components that DEFINE a secret surface (so the scan, which looks for their
// use, does not match them) and must guard themselves.
const SELF_GUARDING_COMPONENTS = ['components/wallet/MnemonicDisplay.tsx'];

// Secret surfaces that must be found by the scan (a vacuity guard: if the regex
// stopped matching, the main assertion would pass on an empty set).
const KNOWN_SECRET_SURFACES = [
  'components/remoteSigner/TransferToAirgapFlow.tsx',
  'components/wallet/MnemonicBackupFlow.tsx',
  'screens/account/CreateAccountScreen.tsx',
  'screens/onboarding/CreateWalletScreen.tsx',
  'screens/remoteSigner/ExportAccountsScreen.tsx',
  'screens/remoteSigner/ImportFromOnlineWalletScreen.tsx',
  'screens/remoteSigner/SignatureDisplayScreen.tsx',
  'screens/settings/ShowRecoveryPhraseScreen.tsx',
  'screens/wallet/VerifyBackupScreen.tsx',
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sources(file);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [file]
      : [];
  });
}

const rel = (file: string) => path.relative(srcRoot, file);
const files = [
  ...sources(path.join(srcRoot, 'screens')),
  ...sources(path.join(srcRoot, 'components')),
];
const text = new Map(files.map((f) => [rel(f), fs.readFileSync(f, 'utf8')]));

describe('secret screens are guarded by useSecureScreen (TASK-493)', () => {
  it('every file that reveals or renders secret material calls useSecureScreen()', () => {
    const missing = [...text.entries()]
      .filter(([file, source]) => SECRET_RENDER.test(source))
      .filter(([file]) => !(file in NOT_SECRET))
      .filter(([, source]) => !/\buseSecureScreen\s*\(/.test(source))
      .map(([file]) => file)
      .sort();
    expect(missing).toEqual([]);
  });

  it('the scan still finds the known secret surfaces (not vacuous)', () => {
    const matched = [...text.entries()]
      .filter(([, source]) => SECRET_RENDER.test(source))
      .map(([file]) => file);
    for (const known of KNOWN_SECRET_SURFACES) {
      expect(matched).toContain(known);
    }
  });

  it('every known secret surface calls useSecureScreen()', () => {
    for (const known of KNOWN_SECRET_SURFACES) {
      expect({
        file: known,
        guarded: /\buseSecureScreen\s*\(/.test(text.get(known) ?? ''),
      }).toEqual({ file: known, guarded: true });
    }
  });

  it('components that define a secret surface guard themselves', () => {
    for (const file of SELF_GUARDING_COMPONENTS) {
      expect({
        file,
        guarded: /\buseSecureScreen\s*\(/.test(text.get(file) ?? ''),
      }).toEqual({ file, guarded: true });
    }
  });

  it('keeps NOT_SECRET honest: every exception still matches the scan', () => {
    for (const file of Object.keys(NOT_SECRET)) {
      expect(text.has(file)).toBe(true);
      expect({
        file,
        matches: SECRET_RENDER.test(text.get(file) ?? ''),
      }).toEqual({ file, matches: true });
    }
  });

  it('useSecureScreen takes the app-switcher protection itself (one call covers both)', () => {
    const hook = fs.readFileSync(
      path.join(srcRoot, 'hooks/useSecureScreen.ts'),
      'utf8'
    );
    const body = hook.slice(hook.indexOf('export function useSecureScreen'));
    const end = body.indexOf('\n}\n');
    expect(body.slice(0, end)).toMatch(/\buseAppSwitcherProtection\s*\(\s*\)/);
  });
});

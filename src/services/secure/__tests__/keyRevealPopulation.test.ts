import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const allowedPrivateReads = new Set([
  'screens/remoteSigner/SignatureDisplayScreen.tsx',
  'services/secure/simplifiedKeyManager.ts',
  'services/secure/keyManager.ts',
  'services/remoteSigner/index.ts',
  'services/messaging/index.ts',
  'services/wallet/ownKeyCustody.ts',
]);

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'dev' || entry.name === '__tests__'
        ? []
        : sources(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [file]
      : [];
  });
}

it('keeps secret reveal APIs and direct key reads within the reviewed population', () => {
  const files = sources(root);
  const hits = (pattern: RegExp) =>
    files
      // Fresh regex per file: a shared /g regex keeps lastIndex between files
      // and can skip a violating file after an earlier hit.
      .filter((file) =>
        new RegExp(pattern.source).test(fs.readFileSync(file, 'utf8'))
      )
      .map((file) => path.relative(root, file))
      .sort();
  const problems: string[] = [];
  const getMnemonic = hits(/\bgetMnemonic\s*\(/g);
  if (getMnemonic.length)
    problems.push(`getMnemonic found in: ${getMnemonic.join(', ')}`);
  const unchecked = hits(/\breadMnemonicUnchecked\s*\(/g);
  if (unchecked.join() !== 'services/secure/keyManager.ts')
    problems.push(`readMnemonicUnchecked found in: ${unchecked.join(', ')}`);
  const expectedMnemonic = [
    'screens/settings/ShowRecoveryPhraseScreen.tsx',
    'screens/wallet/VerifyBackupScreen.tsx',
    'services/backup/collectors.ts',
    'services/secure/keyManager.ts',
  ].sort();
  const revealMnemonic = hits(/\brevealMnemonic\s*\(/g);
  if (JSON.stringify(revealMnemonic) !== JSON.stringify(expectedMnemonic))
    problems.push(`revealMnemonic found in: ${revealMnemonic.join(', ')}`);
  const expectedPrivate = [
    'components/remoteSigner/TransferToAirgapFlow.tsx',
    'services/secure/keyManager.ts',
  ].sort();
  const revealPrivateKey = hits(/\brevealPrivateKey\s*\(/g);
  if (JSON.stringify(revealPrivateKey) !== JSON.stringify(expectedPrivate))
    problems.push(`revealPrivateKey found in: ${revealPrivateKey.join(', ')}`);
  const privateReads = hits(/\.getPrivateKey\s*\(/g);
  if (
    JSON.stringify(privateReads) !==
    JSON.stringify([...allowedPrivateReads].sort())
  )
    problems.push(
      `getPrivateKey call sites found in: ${privateReads.join(', ')}`
    );
  expect(problems).toEqual([]);
});

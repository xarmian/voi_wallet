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
    'services/secure/keyManager.ts',
  ].sort();
  const revealMnemonic = hits(/\brevealMnemonic\s*\(/g);
  if (JSON.stringify(revealMnemonic) !== JSON.stringify(expectedMnemonic))
    problems.push(`revealMnemonic found in: ${revealMnemonic.join(', ')}`);
  // TASK-504: the backup reads each record's key by the record's own id. The
  // by-id reveal is as sensitive as revealMnemonic, so its callers are a
  // reviewed population too: the backup collector, and the key manager itself.
  const expectedByRecord = [
    'services/backup/collectors.ts',
    'services/secure/keyManager.ts',
  ].sort();
  const revealByRecord = hits(/\brevealMnemonicForRecord\s*\(/g);
  if (JSON.stringify(revealByRecord) !== JSON.stringify(expectedByRecord))
    problems.push(
      `revealMnemonicForRecord found in: ${revealByRecord.join(', ')}`
    );
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

// The reveal calls must sit behind a prompt: a screen or flow that calls
// revealMnemonic / revealPrivateKey has to obtain the capability from
// withFreshAuth, and the backup collectors have to take it as a parameter.
it('keeps every reveal caller behind withFreshAuth', () => {
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const gated = [
    'screens/settings/ShowRecoveryPhraseScreen.tsx',
    'screens/wallet/VerifyBackupScreen.tsx',
    'components/remoteSigner/TransferToAirgapFlow.tsx',
  ];
  for (const rel of gated) {
    const source = read(rel);
    expect(`${rel}: ${/withFreshAuth\(/.test(source)}`).toBe(`${rel}: true`);
    // The reveal call must be written inside the withFreshAuth callback.
    expect(
      `${rel}: ${/withFreshAuth\([\s\S]*?\(cap\)\s*=>[\s\S]*?reveal(Mnemonic|PrivateKey)\(/.test(source)}`
    ).toBe(`${rel}: true`);
  }
  expect(
    /cap: FreshAuthCapability/.test(read('services/backup/collectors.ts'))
  ).toBe(true);
  expect(
    /cap: FreshAuthCapability/.test(read('services/backup/index.ts'))
  ).toBe(true);
  expect(
    /withFreshAuth\(\s*'export_backup'/.test(
      read('screens/settings/BackupWalletScreen.tsx')
    )
  ).toBe(true);
});

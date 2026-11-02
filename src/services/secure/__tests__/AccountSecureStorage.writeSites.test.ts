import { readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';

// The original 51 source write sites: 19 now call bounded wrappers, one
// delegates to saveSecret, and 32 remain raw. The unknown journal adds one
// three raw journal sites (write, late-write repair, reset). Counts prevent a
// new raw write in an allowed method from passing.
const IN_SCOPE = new Set([
  'saveSecret',
  'saveSecretV2Checked',
  'migrateLegacyAccountDataLocked',
  'writePendingCreateJournal',
  'getAllAccountIds',
  'addToAccountList',
  'removeFromAccountList',
  'saveMetadata',
  'readStoredPinData',
  'getOrCreateSalt',
]);
const OUT_OF_SCOPE_CLASSIFIED: Record<string, number> = {
  // The unknown-write journal itself uses its own bounded storage operation.
  writeUnknownSnapshot: 2,
  resetUnknownWrites: 1,
  // Wipe path (TASK-469 owns its bounded design): retains inherited same-process
  // SET entries as delete entries (TASK-456 ruling A); journal bookkeeping only.
  rewriteUnknownWritesAfterWipe: 2,
  deleteAccountLocked: 2,
  saveThrottle: 1,
  resetThrottle: 1,
  deletePin: 4,
  setBiometricEnabled: 1,
  isBiometricEnabled: 1,
  setBiometricSecret: 1,
  clearBiometricSecret: 1,
  setPinTimeout: 2,
  getPinTimeout: 2,
  persistPinCredential: 4,
  clearAll: 9,
  markPinSetupPending: 1,
  clearPinSetupPending: 1,
};
const writeRegex =
  /\b(secureStorage|storage)\.(setItem|deleteItem|removeItem|setItemWithAuth|multiSet|multiRemove)\(/g;

function sites(file: string) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const methods: { name: string; start: number; end: number }[] = [];
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
      methods.push({
        name: node.name?.getText(ast) ?? '',
        start: node.getStart(ast),
        end: node.end,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const nameAt = (at: number) =>
    methods
      .filter((m) => m.start <= at && m.end > at)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.name ??
    '(top level)';
  return {
    raw: [...source.matchAll(writeRegex)].map((m) => nameAt(m.index!)),
    bounded: [
      ...source.matchAll(
        /this\.bounded(?:SecureSet|SecureDelete|StorageSet|StorageRemove)\(/g
      ),
    ].map((m) => nameAt(m.index!)),
    delegated: [
      ...source.matchAll(/this\.saveSecret\(accountId, secretPayload\)/g),
    ].map((m) => nameAt(m.index!)),
  };
}

test('all 51 original write sites stay classified', () => {
  const secure = sites('AccountSecureStorage.ts');
  const pending = sites('pinSetupPending.ts');
  const raw = [...secure.raw, ...pending.raw];
  const bounded = [...secure.bounded, ...pending.bounded];
  // 2 raw journal writes in rewriteUnknownWritesAfterWipe were added after the
  // original 51-site census (they are classified above, not part of the 51).
  const addedAfterCensus = 2;
  expect(
    raw.length - 3 - addedAfterCensus + bounded.length + secure.delegated.length
  ).toBe(51);
  expect(bounded.length).toBe(19);
  expect(secure.delegated).toEqual(['migrateLegacyAccountDataLocked']);
  expect(bounded.every((method) => IN_SCOPE.has(method))).toBe(true);
  const actual = raw.reduce<Record<string, number>>((counts, method) => {
    counts[method] = (counts[method] ?? 0) + 1;
    return counts;
  }, {});
  expect(actual).toEqual(OUT_OF_SCOPE_CLASSIFIED);
});

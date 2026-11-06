import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const directories = [
  'src/screens/walletconnect',
  'src/components/walletconnect',
  'src/services/navigation',
];
const signingFile = 'src/screens/wallet/UniversalTransactionSigningScreen.tsx';
const helperFile = 'src/services/navigation/scopedNavigation.ts';
const methods = new Set([
  'goBack',
  'pop',
  'popTo',
  'popToTop',
  'replace',
  'reset',
  'navigate',
  'dispatch',
  'push',
  'setParams',
]);

type Row = {
  file: string;
  line: number;
  fn: string;
  receiver: string;
  method: string;
};
function enclosing(node: ts.Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    if (parent.name) return parent.name.getText();
    const declaration = parent.parent;
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration)
    )
      return declaration.name.getText();
  }
  return '<module>';
}
function parse(file: string, text: string): Row[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rows: Row[] = [];
  function visit(node: ts.Node) {
    // PropertyAccessExpression also includes optional access/call chains.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      methods.has(node.expression.name.text)
    ) {
      rows.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        fn: enclosing(node),
        receiver: node.expression.expression.getText(source),
        method: node.expression.name.text,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return rows;
}
const key = (row: Omit<Row, 'line'>) =>
  [row.file, row.fn, row.method, row.receiver].join(' | ');
const allow = (
  file: string,
  fn: string,
  method: string,
  receiver: string,
  reason: string
) => [key({ file, fn, method, receiver }), reason] as const;
const qr = 'src/screens/walletconnect/QRScannerScreen.tsx';
const sessions = 'src/screens/walletconnect/SessionsScreen.tsx';
const error = 'src/screens/walletconnect/WalletConnectErrorScreen.tsx';
const request = 'src/screens/walletconnect/TransactionRequestScreen.tsx';
// Population table: exceptions are keyed by semantic location, never line number.
const ALLOWLIST = new Map([
  allow(
    signingFile,
    'decodeNoteForDisplay',
    'replace',
    "Buffer.from(note)\n    .toString('utf8')",
    'String sanitization, not navigation.'
  ),
  allow(
    signingFile,
    'pushUndecodable',
    'push',
    'parsed',
    'Array accumulation, not navigation.'
  ),
  allow(
    signingFile,
    'pushUndecodable',
    'push',
    'decoded',
    'Array accumulation, not navigation.'
  ),
  allow(
    signingFile,
    'parseBatch',
    'push',
    'decoded',
    'Array accumulation, not navigation.'
  ),
  allow(
    signingFile,
    'parseBatch',
    'push',
    'parsed',
    'Array accumulation, not navigation.'
  ),
  allow(
    signingFile,
    'handleReject',
    'goBack',
    'navigation',
    'In-app, no walletConnect; fallback when no onReject callback.'
  ),
  allow(
    signingFile,
    'handleReject',
    'navigate',
    'navigation',
    'In-app, no walletConnect; root fallback when no onReject callback.'
  ),
  allow(
    qr,
    'handleClose',
    'goBack',
    'navigation',
    'User-initiated navigation on the focused scanner.'
  ),
  allow(
    qr,
    'handleClose',
    'navigate',
    'navigation',
    'User-initiated navigation on the focused scanner.'
  ),
  allow(
    qr,
    'handleSuccess',
    'navigate',
    'navigation',
    'User-initiated scan on the focused scanner.'
  ),
  allow(
    qr,
    'handleSuccess',
    'goBack',
    'navigation',
    'User-initiated scan on the focused scanner.'
  ),
  allow(
    sessions,
    'renderSessionItem',
    'pop',
    "account.split(':')",
    'Array CAIP address extraction, not navigation.'
  ),
  allow(
    sessions,
    'renderEmptyState',
    'navigate',
    'navigation',
    'User-initiated navigation on the focused sessions screen.'
  ),
  allow(
    sessions,
    'SessionsScreen',
    'goBack',
    'navigation',
    'User-initiated navigation on the focused sessions screen.'
  ),
  allow(
    'src/screens/walletconnect/WalletConnectPairingScreen.tsx',
    'WalletConnectPairingScreen',
    'goBack',
    'navigation',
    'User-initiated navigation on the focused pairing screen.'
  ),
  allow(
    error,
    'WalletConnectErrorScreen',
    'navigate',
    'navigation',
    'Root fallback only when !canGoBack(); nothing can be popped.'
  ),
  allow(
    request,
    'advanceAfterEnd',
    'navigate',
    'navRef.current',
    'Root request fallback only when !canGoBack(); nothing can be popped.'
  ),
  allow(
    helperFile,
    'goBack',
    'pop',
    'StackActions',
    'Creates the action dispatched with the stack target.'
  ),
  allow(
    helperFile,
    'replace',
    'replace',
    'StackActions',
    'Creates the action dispatched with the stack target.'
  ),
]);
const COUNTS: Record<string, number> = {
  'src/components/walletconnect/AccountSelectionItem.tsx': 0,
  'src/components/walletconnect/ConnectionStatus.tsx': 0,
  'src/components/walletconnect/DAppInfo.tsx': 0,
  'src/components/walletconnect/LockedRequestGate.tsx': 0,
  'src/components/walletconnect/QRScanner.tsx': 0,
  'src/components/walletconnect/RequestAgeLabel.tsx': 0,
  [signingFile]: 7,
  [qr]: 5,
  'src/screens/walletconnect/SessionProposalScreen.tsx': 9,
  [sessions]: 3,
  [request]: 8,
  [error]: 4,
  'src/screens/walletconnect/WalletConnectPairingScreen.tsx': 1,
  'src/services/navigation/callbackRegistry.ts': 0,
  [helperFile]: 7,
};
function scoped(row: Row) {
  return (
    row.receiver === 'scoped' ||
    row.receiver === 'navRef.current' ||
    (row.file === helperFile && row.receiver === 'navigation')
  );
}
function audit(rows: Row[]) {
  const unknown = rows.filter(
    (row) => !scoped(row) && !ALLOWLIST.has(key(row))
  );
  const stale = [...ALLOWLIST.keys()].filter(
    (entry) => !rows.some((row) => key(row) === entry)
  );
  expect(unknown).toEqual([]);
  expect(stale).toEqual([]);
}
it('U6 navigation census has no unscoped calls, stale exceptions, or population drift', () => {
  const files = [
    ...directories.flatMap((directory) =>
      fs
        .readdirSync(directory)
        .filter((file) =>
          file.endsWith(directory.includes('services') ? '.ts' : '.tsx')
        )
        .map((file) => path.posix.join(directory, file))
    ),
    signingFile,
  ].sort();
  const rows = files.flatMap((file) =>
    parse(file, fs.readFileSync(file, 'utf8'))
  );
  const output =
    rows
      .map(
        (row) =>
          `${row.file}:${row.line}\t${row.fn}\t${row.receiver.replace(/\s+/g, ' ')}.${row.method}(...)\t${ALLOWLIST.has(key(row)) ? `allowed:${ALLOWLIST.get(key(row))}` : scoped(row) ? 'scoped' : 'UNSCOPED'}`
      )
      .join('\n') + '\n';
  if (process.env.CENSUS_OUT) fs.writeFileSync(process.env.CENSUS_OUT, output);
  audit(rows);
  expect(
    Object.fromEntries(
      files.map((file) => [
        file,
        rows.filter((row) => row.file === file).length,
      ])
    )
  ).toEqual(COUNTS);
});
it('U6 census recognizes optional navigation access and calls', () => {
  expect(
    parse('fixture.tsx', 'function sample() { navigation?.goBack?.(); }')
  ).toEqual([
    {
      file: 'fixture.tsx',
      line: 1,
      fn: 'sample',
      receiver: 'navigation',
      method: 'goBack',
    },
  ]);
});

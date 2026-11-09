// This census proves call receivers, not behaviour; the router tests (stackScoping.test.tsx) prove behaviour.
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const directories = [
  'src/screens/walletconnect',
  'src/components/walletconnect',
  'src/services/navigation',
];
const signingFile = 'src/screens/wallet/UniversalTransactionSigningScreen.tsx';
const bootstrap = 'src/navigation/serviceBootstrap.ts';
const deeplink = 'src/services/deeplink/index.ts';
// WalletConnect request/proposal delivery and the scan-driven replace only.
const DELIVERY_FUNCTIONS: Record<string, string[]> = {
  [bootstrap]: ['onProposal', 'onRequest'],
  [deeplink]: [
    'onV1CallRequest',
    'handleWalletConnectV1Uri',
    'navigateToRoute',
    'handleKeyregUri',
    'handleApplUri',
    'handleAppQueryUri',
    'handleAssetQueryUri',
  ],
};
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
  'popOrReplace',
  'navigateToRoute',
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
      ts.isPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration)
    )
      return declaration.name.getText();
    if (
      ts.isBinaryExpression(declaration) &&
      declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      return declaration.left.getText();
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
    'navigate',
    'navigation',
    'Scanner root fallback only when !canGoBack(); no route can be popped.'
  ),
  allow(
    qr,
    'handleSuccess',
    'navigate',
    'navigation',
    'Payment/address scan opens the Send feature on Home.'
  ),
  allow(
    helperFile,
    'navigate',
    'navigate',
    'navigation',
    'Raw passthrough; callers require their own allowlist reason.'
  ),
  allow(
    bootstrap,
    'onProposal',
    'goBack',
    'nav',
    'Synchronous guarded pop only when the current route is QRScanner and canGoBack(); the proposal itself enters the queue and no route is pushed.'
  ),
  allow(
    deeplink,
    'handleWalletConnectV1Uri',
    'navigateToRoute',
    'this',
    'Pairing errors open the error route without persisting the URI; a v1 proposal enters the queue and no route is pushed.'
  ),
  ...[
    'handleKeyregUri',
    'handleApplUri',
    'handleAppQueryUri',
    'handleAssetQueryUri',
  ].map((fn) =>
    allow(
      deeplink,
      fn,
      'navigateToRoute',
      'this',
      'ARC-0090 scan replaces the scanner by source/target when present; otherwise retains the existing fallback.'
    )
  ),
  allow(
    deeplink,
    'navigateToRoute',
    'dispatch',
    'this.navigationRef',
    'Scan replace targets QRScanner when present; optional push stacks proposals.'
  ),
  allow(
    deeplink,
    'navigateToRoute',
    'replace',
    'StackActions',
    'Creates the scan replace action; scanner source and root target are added by the dispatcher.'
  ),
  allow(
    deeplink,
    'navigateToRoute',
    'push',
    'StackActions',
    'Creates the optional proposal push action.'
  ),
  allow(
    deeplink,
    'navigateToRoute',
    'navigate',
    '(this.navigationRef as any)',
    'Default deep-link routing; only explicit replace/push options alter delivery.'
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
  ...['goBack', 'replace'].map((fn) =>
    allow(
      helperFile,
      fn,
      'dispatch',
      'navigation',
      'Scoped helper implementation checks route presence and adds the stack target.'
    )
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
  [qr]: 3,
  'src/screens/walletconnect/SessionProposalScreen.tsx': 10,
  [bootstrap]: 1,
  [deeplink]: 10,
  [sessions]: 3,
  [error]: 4,
  'src/screens/walletconnect/WalletConnectPairingScreen.tsx': 1,
  'src/services/navigation/callbackRegistry.ts': 0,
  [helperFile]: 7,
};
function scoped(row: Row) {
  return (
    ['goBack', 'replace', 'popOrReplace', 'pop'].includes(row.method) &&
    (row.receiver === 'scoped' || row.receiver === 'navRef.current')
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
it('This census proves call receivers, not behaviour; the router tests (stackScoping.test.tsx) prove behaviour.', () => {
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
    ...Object.keys(DELIVERY_FUNCTIONS),
  ].sort();
  const rows = files.flatMap((file) =>
    parse(file, fs.readFileSync(file, 'utf8')).filter(
      (row) =>
        !DELIVERY_FUNCTIONS[file] || DELIVERY_FUNCTIONS[file].includes(row.fn)
    )
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

it('U7 census treats scoped.navigate as a raw passthrough requiring its own reason', () => {
  const [row] = parse(
    'fixture.tsx',
    "function sample() { scoped.navigate('Main'); }"
  );
  expect(scoped(row)).toBe(false);
});

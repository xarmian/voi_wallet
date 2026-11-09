import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const queueModule = 'src/services/walletconnect/requestQueue.ts';
const screen = 'src/screens/walletconnect/TransactionRequestScreen.tsx';
// The production value importers: the host draws the queue, the lock screen
// reads it, and feedQueue is the one point where an admitted arrival enters it.
const lockScreen = 'src/screens/auth/LockScreen.tsx';
const feedPoint = 'src/services/walletconnect/feedQueue.ts';
const queueImporters = [
  'src/components/wcHost/WalletConnectHost.tsx',
  lockScreen,
  feedPoint,
];
const hostImporter = 'src/navigation/AppNavigator.tsx';
const hostController = 'src/components/wcHost/headSession.ts';

function inspect(text: string) {
  const source = ts.createSourceFile(
    'source.tsx',
    text,
    ts.ScriptTarget.Latest,
    true
  );
  const queueNames = new Set(['RequestQueue']);
  const instances = new Set<string>();
  let importsQueue = false;
  let importsController = false;
  let importsHost = false;
  const hostNames = new Set<string>();
  const hostMountAttributes: number[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const module = statement.moduleSpecifier.text;
    if (/(^|\/)WalletConnectHost$/.test(module)) {
      importsHost = true;
      const clause = statement.importClause;
      if (clause?.name) hostNames.add(clause.name.text);
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const binding of named.elements) hostNames.add(binding.name.text);
      }
    }
    if (/(^|\/)signRequestController$/.test(module)) importsController = true;
    if (
      !/(^|\/)requestQueue$/.test(module) ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (
          !binding.isTypeOnly &&
          (binding.propertyName ?? binding.name).text === 'RequestQueue'
        ) {
          importsQueue = true;
          queueNames.add(binding.name.text);
        }
      }
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      importsQueue = true;
      queueNames.add(`${bindings.name.text}.RequestQueue`);
    }
  }
  const isInstance = (node: ts.Node) =>
    (ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'getInstance' &&
      queueNames.has(node.expression.expression.getText(source))) ||
    (ts.isNewExpression(node) &&
      queueNames.has(node.expression.getText(source)));
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isInstance(node.initializer)
    )
      instances.add(node.name.getText(source));
    ts.forEachChild(node, collect);
  };
  collect(source);
  let pushes = 0;
  const mutations: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      (hostNames.has(node.tagName.getText(source)) ||
        node.tagName.getText(source) === 'WalletConnectHost')
    ) {
      hostMountAttributes.push(node.attributes.properties.length);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      (isInstance(node.expression.expression) ||
        instances.has(node.expression.expression.getText(source)))
    )
      pushes++;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      [
        'push',
        'finish',
        'closeHead',
        'advance',
        'dismissResult',
        'amendResult',
        'finishApproved',
      ].includes(node.expression.name.text) &&
      (isInstance(node.expression.expression) ||
        instances.has(node.expression.expression.getText(source)))
    )
      mutations.push(node.expression.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    pushes,
    mutations,
    importsQueue,
    importsController,
    importsHost,
    hostMountAttributes,
  };
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(directory, entry.name);
    if (/__tests__|\.test\.|\.spec\./.test(file)) return [];
    if (entry.isDirectory()) return walk(file);
    return /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

it('REGRESSION matcher detects queue pushes and excludes array pushes, comments and type imports', () => {
  for (const fixture of [
    'RequestQueue.getInstance().push(request);',
    'const queue = RequestQueue.getInstance(); queue.push(request);',
    'const queue = new RequestQueue(); queue.push(request);',
    "import { RequestQueue as Queue } from './requestQueue'; const q = Queue.getInstance(); q.push(request);",
  ])
    expect(inspect(fixture).pushes).toBe(1);
  expect(inspect('const items = []; items.push(request);').pushes).toBe(0);
  expect(inspect('// RequestQueue.getInstance().push(request);').pushes).toBe(
    0
  );
  expect(
    inspect("import type { RequestQueue } from './requestQueue';").importsQueue
  ).toBe(false);
  expect(
    inspect("import { type RequestQueue } from './requestQueue';").importsQueue
  ).toBe(false);
  expect(
    inspect("import { RequestQueue } from './requestQueue';").importsQueue
  ).toBe(true);
});

it('DEFECT single owner: no production queue feed, fixed value importers, one controller adapter', () => {
  const files = walk('src');
  const rows = files.map((file) => ({
    file,
    ...inspect(fs.readFileSync(file, 'utf8')),
  }));
  const feeds = rows
    .filter((row) => row.file !== queueModule && row.pushes > 0)
    .map((row) => row.file);
  const importers = rows
    .filter((row) => row.importsQueue)
    .map((row) => row.file)
    .sort();
  const controllers = rows
    .filter((row) => row.importsController)
    .map((row) => row.file)
    .sort();
  expect({
    message: `${files.length} source files; ${feeds.length} queue feed files`,
    files: feeds,
  }).toEqual({
    message: `${files.length} source files; 0 queue feed files`,
    files: [],
  });
  expect({
    message: `${importers.length} RequestQueue value importer files`,
    files: importers,
  }).toEqual({
    message: `${queueImporters.length} RequestQueue value importer files`,
    files: queueImporters,
  });
  expect({
    message: `${controllers.length} controller importer files`,
    files: controllers,
  }).toEqual({
    message: '2 controller importer files',
    files: [hostController, screen].sort(),
  });
});

it('DEFECT only the two producer files feed the queue, and each producer feeds it through feedQueue', () => {
  const callers = walk('src')
    .filter((file) => file !== feedPoint)
    .filter((file) => /\bfeedQueue\(/.test(fs.readFileSync(file, 'utf8')))
    .sort();
  expect(callers).toEqual([
    'src/navigation/serviceBootstrap.ts',
    'src/services/deeplink/index.ts',
  ]);
  // v2 proposal and request in the boot, v1 request and proposal in the link
  // service: four producers, four calls.
  const count = (file: string) =>
    (fs.readFileSync(file, 'utf8').match(/\bfeedQueue\(/g) ?? []).length;
  expect(count('src/navigation/serviceBootstrap.ts')).toBe(2);
  expect(count('src/services/deeplink/index.ts')).toBe(2);
});

it('DEFECT only AppNavigator imports the host and mounts it once with zero JSX attributes', () => {
  const files = walk('src');
  const rows = files.map((file) => ({
    file,
    ...inspect(fs.readFileSync(file, 'utf8')),
  }));
  const importers = rows
    .filter((row) => row.importsHost)
    .map((row) => row.file);
  expect({
    message: `${importers.length} host importer files`,
    files: importers,
  }).toEqual({ message: '1 host importer files', files: [hostImporter] });
  const mounts = rows.filter((row) => row.hostMountAttributes.length);
  expect({
    message: `${mounts.length} host mounting files`,
    files: mounts.map((row) => row.file),
  }).toEqual({ message: '1 host mounting files', files: [hostImporter] });
  expect(
    rows.find((row) => row.file === hostImporter)?.hostMountAttributes
  ).toEqual([0]);
});
it('REGRESSION host matcher counts actual JSX attributes including spread and aliases', () => {
  expect(
    inspect("import Host from './WalletConnectHost'; const v = <Host />;")
      .hostMountAttributes
  ).toEqual([0]);
  expect(
    inspect(
      "import Host from './WalletConnectHost'; const v = <Host live={data} />;"
    ).hostMountAttributes
  ).toEqual([1]);
  expect(
    inspect('const v = <WalletConnectHost {...data}></WalletConnectHost>;')
      .hostMountAttributes
  ).toEqual([1]);
  expect(
    inspect('// <WalletConnectHost live={data} />').hostMountAttributes
  ).toEqual([]);
  expect(inspect("import Host from './WalletConnectHost';").importsHost).toBe(
    true
  );
});

it('DEFECT LockScreen is a read-only queue subscriber with no queue mutations', () => {
  expect(inspect(fs.readFileSync(lockScreen, 'utf8')).mutations).toEqual([]);
});

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const queueModule = 'src/services/walletconnect/requestQueue.ts';
const screen = 'src/screens/walletconnect/TransactionRequestScreen.tsx';
// Repository scan before extraction: no production value importers exist yet.
const queueImporters: string[] = [];

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
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const module = statement.moduleSpecifier.text;
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
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      (isInstance(node.expression.expression) ||
        instances.has(node.expression.expression.getText(source)))
    )
      pushes++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { pushes, importsQueue, importsController };
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
  }).toEqual({ message: '1 controller importer files', files: [screen] });
});

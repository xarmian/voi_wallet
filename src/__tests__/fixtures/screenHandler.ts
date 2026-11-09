import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Execute the actual screen callback with injected closure dependencies. This
 * keeps controller-to-caller contract tests independent of native rendering and
 * quote/claim preparation, while exercising the production submission code.
 */
export function screenHandler(
  screen: string,
  name: string,
  scope: Record<string, unknown>
): (...args: any[]) => Promise<void> {
  const filename = path.join(__dirname, '../../screens', screen + '.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.name.getText(ast) === name
    ) {
      expression = node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!expression) throw new Error(`Missing ${name} in ${screen}`);
  const js = ts.transpileModule(`const handler = ${expression.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new Function(...Object.keys(scope), js + '\nreturn handler;')(
    ...Object.values(scope)
  );
}

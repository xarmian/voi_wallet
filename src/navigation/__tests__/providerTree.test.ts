import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';

// A gorhom bottom sheet portals into its BottomSheetModalProvider's host. The
// lock cover only hides what is inside RootLockBoundary, so the provider must
// sit inside it. This reads the real provider tree in AppNavigator.
function jsxTree() {
  const text = readFileSync(resolve(__dirname, '../AppNavigator.tsx'), 'utf8');
  const source = ts.createSourceFile(
    'AppNavigator.tsx',
    text,
    ts.ScriptTarget.Latest,
    true
  );
  const ancestors = (node: ts.Node, name: string): boolean => {
    for (let p = node.parent; p; p = p.parent) {
      if (
        ts.isJsxElement(p) &&
        p.openingElement.tagName.getText(source) === name
      )
        return true;
    }
    return false;
  };
  const found: {
    name: string;
    inBoundary: boolean;
    inProvider: boolean;
    wrapsBoundary: boolean;
  }[] = [];
  const visit = (node: ts.Node) => {
    const tag = ts.isJsxSelfClosingElement(node)
      ? node.tagName.getText(source)
      : ts.isJsxElement(node)
        ? node.openingElement.tagName.getText(source)
        : null;
    if (tag) {
      found.push({
        name: tag,
        inBoundary: ancestors(node, 'RootLockBoundary'),
        inProvider: ancestors(node, 'BottomSheetModalProvider'),
        wrapsBoundary:
          tag === 'BottomSheetModalProvider' &&
          ts.isJsxElement(node) &&
          node
            .getText(source)
            .includes('<RootLockBoundary') /* provider above the boundary */,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it('DEFECT the bottom sheet provider is inside the lock boundary and does not wrap it', () => {
  const tree = jsxTree();
  const providers = tree.filter(
    (row) => row.name === 'BottomSheetModalProvider'
  );
  expect(providers).toHaveLength(1);
  expect(providers[0].inBoundary).toBe(true);
  expect(providers[0].wrapsBoundary).toBe(false);
});
it('DEFECT the navigator and the host are inside both the lock boundary and the bottom sheet provider', () => {
  const tree = jsxTree();
  for (const name of ['NavigationActivityWrapper', 'WalletConnectHost']) {
    const rows = tree.filter((row) => row.name === name);
    expect(rows).toHaveLength(1);
    expect(rows[0].inBoundary).toBe(true);
    expect(rows[0].inProvider).toBe(true);
  }
});

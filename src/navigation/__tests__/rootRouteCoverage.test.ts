import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ROOT_ROUTE_COVERAGE } from '../rootRouteCoverage';

function extract(source: string): string[] {
  return [...source.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map(
    (match) => match[1]
  );
}
it('DEFECT every root screen has exactly one census row and no row is stale', () => {
  const routes = extract(
    readFileSync(resolve(__dirname, '../AppNavigator.tsx'), 'utf8')
  );
  expect({
    extractedCount: routes.length,
    routes: [...new Set(routes)].sort(),
  }).toEqual({
    extractedCount: Object.keys(ROOT_ROUTE_COVERAGE).length,
    routes: Object.keys(ROOT_ROUTE_COVERAGE).sort(),
  });
});
it('DEFECT regex self-check excludes nested WalletStack screens', () => {
  expect(extract('<WalletStack.Screen name="Foo" />')).toEqual([]);
  expect(extract('<Stack.Screen\n name="Main" />')).toEqual(['Main']);
});

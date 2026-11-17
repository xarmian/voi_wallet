import { readFileSync } from 'fs';
import { resolve } from 'path';

it('DEFECT proposal exits never reject a session directly', () => {
  const source = readFileSync(
    resolve(__dirname, '../SessionProposalScreen.tsx'),
    'utf8'
  );
  expect(source).not.toMatch(/\.rejectSession\s*\(/);
});

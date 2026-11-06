import { readFileSync } from 'fs';
import { resolve } from 'path';

// DEFECT: every request exit must use the coordinator; retain this population gate.
it('DEFECT TRS has no unrecorded delivery forgetting or direct rejection sends', () => {
  const source = readFileSync(
    resolve(__dirname, '../TransactionRequestScreen.tsx'),
    'utf8'
  );
  expect(source).not.toContain('TransactionRequestQueue.forgetDelivery(');
  expect(source).not.toMatch(/\.rejectRequest\s*\(/);
  expect(source).not.toMatch(/\.rejectSession\s*\(/);
});

it('DEFECT UTS routes terminal outcomes to its caller', () => {
  const source = readFileSync(
    resolve(__dirname, '../../wallet/UniversalTransactionSigningScreen.tsx'),
    'utf8'
  );
  expect(source).toContain('onEnd');
  expect(source).toContain('endRequest');
  expect(source).not.toMatch(
    /\.(rejectRequest|rejectSession|sendError|settle)\s*\(/
  );
});

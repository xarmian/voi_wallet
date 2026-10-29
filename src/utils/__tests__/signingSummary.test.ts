jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));
import { signingSummary } from '../signingSummary';
it('formats payments and uint64 amounts exactly', () => {
  expect(
    signingSummary([{ amount: 12500000n, to: 'ABCDEFGH1234WXYZ' }], 'VOI', {})
  ).toBe('Send 12.5 VOI to ABCD…WXYZ');
  expect(
    signingSummary(
      [{ amount: 18446744073709551615n, to: 'ABCDWXYZ' }],
      'VOI',
      {}
    )
  ).toContain('18446744073709.551615');
});
it('never guesses asset decimals', () => {
  expect(
    signingSummary([{ amount: 123n, assetId: 42n, to: 'ABCDWXYZ' }], 'VOI', {})
  ).toContain('123 base units (Asset #42)');
});
it('summarizes groups and unreadable entries and sanitizes dApp text', () => {
  expect(signingSummary([{}, {}], 'VOI', {}, 'example.org')).toBe(
    'Sign 2 transactions for example.org'
  );
  expect(signingSummary([{}], 'VOI', {}, 'a\n' + 'b'.repeat(100))).not.toMatch(
    /\n/
  );
  expect(signingSummary([{}], 'VOI', {}, 'a'.repeat(100)).length).toBeLessThan(
    110
  );
});
it('strips every bidi control from dApp text, including LRM/RLM/ALM', () => {
  for (const mark of ['؜', '‎', '‏', '‪', '‮', '⁦', '⁩']) {
    expect(signingSummary([{}], 'VOI', {}, `evil${mark}gro.elpmaxe`)).toBe(
      'Sign 1 transaction for evil gro.elpmaxe'
    );
  }
});

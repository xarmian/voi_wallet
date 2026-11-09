/**
 * DR-18 (FR-374): the Node side of the Hermes crypto parity self-test.
 *
 * EXPECTED_DIGESTS in src/dev/cryptoSelfTest.ts are the digests this suite
 * produces under Node. If a dependency bump changes any vector's output here,
 * this suite goes red; the on-device run then compares Hermes against the same
 * committed digests.
 */
import {
  CRYPTO_SELFTEST_MARKER,
  EXPECTED_DIGESTS,
  PBKDF2_KAT,
  SCRYPT_KAT,
  VECTOR_NAMES,
  computeVectorDigest,
  runCryptoSelfTest,
  type VectorName,
} from '../cryptoSelfTest';
import { SCRYPT_PARITY_KAT } from '@/services/secure/scryptKdf';
import { PBKDF2_PARITY_KAT } from '@/services/secure/pbkdf2Kdf';

describe('DR-18 crypto self-test (Node reference run)', () => {
  it.each(VECTOR_NAMES.map((n) => [n]))(
    '%s matches its committed digest',
    async (name) => {
      const digest = await computeVectorDigest(name as VectorName);
      expect(digest).toBe(EXPECTED_DIGESTS[name as VectorName]);
    }
  );

  it('is deterministic across runs', async () => {
    for (const name of VECTOR_NAMES) {
      expect(await computeVectorDigest(name)).toBe(
        await computeVectorDigest(name)
      );
    }
  });

  it('logs only PASS/FAIL plus the vector name, and passes every vector', async () => {
    const lines: string[] = [];
    const result = await runCryptoSelfTest({ log: (l) => lines.push(l) });

    expect(result.failed).toEqual([]);
    expect(result.passed).toEqual([...VECTOR_NAMES]);
    const allowed = new Set<string>([...VECTOR_NAMES, 'all']);
    expect(lines).toHaveLength(VECTOR_NAMES.length + 1);
    for (const line of lines) {
      const m = line.match(/^\[([A-Z0-9_]+)\] (PASS|FAIL) ([a-z0-9-]+)$/);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(CRYPTO_SELFTEST_MARKER);
      expect(allowed.has(m![3])).toBe(true);
    }
    expect(lines[lines.length - 1]).toBe(
      `[${CRYPTO_SELFTEST_MARKER}] PASS all`
    );
  });

  it('reports FAIL (and FAIL all) when a digest does not match', async () => {
    const lines: string[] = [];
    const result = await runCryptoSelfTest({
      log: (l) => lines.push(l),
      expected: { ...EXPECTED_DIGESTS, 'sign-payment': '00'.repeat(32) },
    });
    expect(result.failed).toEqual(['sign-payment']);
    expect(lines).toContain(`[${CRYPTO_SELFTEST_MARKER}] FAIL sign-payment`);
    expect(lines[lines.length - 1]).toBe(
      `[${CRYPTO_SELFTEST_MARKER}] FAIL all`
    );
  });

  it('keeps its KDF KAT copies equal to the production parity KATs', () => {
    expect(SCRYPT_KAT.pw).toBe(SCRYPT_PARITY_KAT.pw);
    expect(SCRYPT_KAT.salt).toBe(SCRYPT_PARITY_KAT.salt);
    expect({ ...SCRYPT_KAT.params }).toEqual({ ...SCRYPT_PARITY_KAT.params });
    expect(SCRYPT_KAT.expectedHex).toBe(SCRYPT_PARITY_KAT.expectedHex);
    expect({ ...PBKDF2_KAT }).toEqual({ ...PBKDF2_PARITY_KAT });
  });
});

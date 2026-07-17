import { Buffer } from 'buffer';
import nacl from 'tweetnacl';

import {
  parseArc0300AccountImportUri,
  normalizeBase64ToHex,
  collectArc0300Entries,
  isArc0300AccountImportUri,
  generateArc0300AccountExportUri,
} from '../arc0300';

// --- Independent spec helpers -------------------------------------------------
// RFC 4648 §5 "URL-safe" base64 (no padding). This is the canonical definition
// of the transform ARC-0300 requires — computing expectations this way is
// spec-based, not a copy of "whatever the code returns".
const toB64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// Deterministic Ed25519 material: seed(32) -> secretKey(64) = seed || pubkey.
const makeSeed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const makeSecretKey = (fill: number): Uint8Array =>
  nacl.sign.keyPair.fromSeed(makeSeed(fill)).secretKey; // 64 bytes
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('arc0300', () => {
  describe('generateArc0300AccountExportUri', () => {
    it('builds a canonical avm://account/import URI with URL-safe base64', () => {
      const sk = makeSecretKey(7);
      const uri = generateArc0300AccountExportUri({ privateKeyBytes: sk });
      expect(uri).toBe(`avm://account/import?privatekey=${toB64Url(sk)}`);
    });

    it('strips base64 padding and uses URL-safe alphabet (no + / =)', () => {
      // 0xFB bytes force both '+' and '/' in standard base64.
      const sk = new Uint8Array(64).fill(0xfb);
      const uri = generateArc0300AccountExportUri({ privateKeyBytes: sk });
      const payload = uri.split('privatekey=')[1];
      expect(payload).not.toMatch(/[+/=]/);
      expect(payload).toMatch(/[-_]/);
      expect(payload).toBe(toB64Url(sk));
    });

    it('appends a percent-encoded name when provided', () => {
      const sk = makeSecretKey(3);
      const uri = generateArc0300AccountExportUri({
        privateKeyBytes: sk,
        name: 'My Wallet',
      });
      expect(uri).toBe(
        `avm://account/import?privatekey=${toB64Url(sk)}&name=My%20Wallet`
      );
    });

    it('encodes reserved characters in the name so they do not break the query', () => {
      const sk = makeSecretKey(4);
      const uri = generateArc0300AccountExportUri({
        privateKeyBytes: sk,
        name: 'A & B',
      });
      // encodeURIComponent('A & B') === 'A%20%26%20B'
      expect(uri.endsWith('&name=A%20%26%20B')).toBe(true);
    });

    it('omits the name segment for an empty name', () => {
      const sk = makeSecretKey(5);
      const uri = generateArc0300AccountExportUri({
        privateKeyBytes: sk,
        name: '',
      });
      expect(uri).toBe(`avm://account/import?privatekey=${toB64Url(sk)}`);
    });

    it('throws for a private key that is not 64 bytes', () => {
      expect(() =>
        generateArc0300AccountExportUri({ privateKeyBytes: new Uint8Array(32) })
      ).toThrow('Invalid private key length: expected 64 bytes, got 32');
      expect(() =>
        generateArc0300AccountExportUri({ privateKeyBytes: new Uint8Array(0) })
      ).toThrow('Invalid private key length: expected 64 bytes, got 0');
    });

    // TASK-146 secret-hygiene contract: the function zeroes only its OWN
    // transient Buffer copy of the secret and must NOT mutate the caller's
    // array (the caller owns zeroing its own key). A regression that zeroed the
    // input in place would corrupt the caller's key before it can be used/zeroed.
    it('does not mutate the caller-supplied privateKeyBytes', () => {
      const sk = makeSecretKey(9);
      const before = Array.from(sk);
      const uri = generateArc0300AccountExportUri({ privateKeyBytes: sk });
      // The input array is unchanged...
      expect(Array.from(sk)).toEqual(before);
      // ...and the URI encodes the original (unzeroed) key.
      expect(uri).toBe(`avm://account/import?privatekey=${toB64Url(sk)}`);
    });
  });

  describe('parseArc0300AccountImportUri', () => {
    it('parses a standard (private-key) import', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&name=Alice'
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe('standard');
      expect(parsed!.scheme).toBe('avm');
      expect(parsed!.entries).toEqual([
        { privateKeyBase64: 'K1', name: 'Alice' },
      ]);
    });

    it('accepts the "algorand" scheme too', () => {
      const parsed = parseArc0300AccountImportUri(
        'algorand://account/import?privatekey=K1'
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.scheme).toBe('algorand');
      expect(parsed!.kind).toBe('standard');
    });

    it('lowercases the scheme (case-insensitive)', () => {
      const parsed = parseArc0300AccountImportUri(
        'AVM://account/import?privatekey=K1'
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.scheme).toBe('avm');
    });

    it('trims surrounding whitespace on the whole URI', () => {
      const parsed = parseArc0300AccountImportUri(
        '   avm://account/import?address=ADDR   '
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe('watch');
      expect(parsed!.entries).toEqual([{ address: 'ADDR' }]);
    });

    it('trims whitespace inside a private-key value', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=%20AAAA%20'
      );
      expect(parsed!.entries[0].privateKeyBase64).toBe('AAAA');
    });

    it('parses multiple key/name pairs, matching names by index', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&name=One&privatekey=K2&name=Two'
      );
      expect(parsed!.entries).toEqual([
        { privateKeyBase64: 'K1', name: 'One' },
        { privateKeyBase64: 'K2', name: 'Two' },
      ]);
    });

    it('leaves name undefined when fewer names than keys are supplied', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&privatekey=K2&name=Only'
      );
      expect(parsed!.entries).toEqual([
        { privateKeyBase64: 'K1', name: 'Only' },
        { privateKeyBase64: 'K2', name: undefined },
      ]);
    });

    it('prefers a private-key import over an address when both are present', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&address=ADDR'
      );
      expect(parsed!.kind).toBe('standard');
      expect(parsed!.entries[0].privateKeyBase64).toBe('K1');
      // address is ignored when a private key is present
      expect(parsed!.entries[0].address).toBeUndefined();
    });

    it('parses a watch (address-only) import', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?address=ABCDEF'
      );
      expect(parsed!.kind).toBe('watch');
      expect(parsed!.entries).toEqual([{ address: 'ABCDEF' }]);
    });

    it('captures the checksum query parameter', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&checksum=deadbeef'
      );
      expect(parsed!.checksum).toBe('deadbeef');
    });

    it('parses valid "index:total" pagination', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&page=1:4'
      );
      expect(parsed!.pagination).toEqual({ index: 1, total: 4 });
    });

    it('accepts a zero page index', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&page=0:2'
      );
      expect(parsed!.pagination).toEqual({ index: 0, total: 2 });
    });

    it('rejects pagination when total is not positive', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&page=1:0'
      );
      expect(parsed!.pagination).toBeUndefined();
    });

    it('rejects non-numeric pagination', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&page=abc'
      );
      expect(parsed!.pagination).toBeUndefined();
    });

    describe('returns null for malformed / non-matching URIs', () => {
      const invalid: [string, string][] = [
        ['empty string', ''],
        ['whitespace only', '   '],
        ['missing scheme', 'account/import?privatekey=K1'],
        ['unsupported scheme', 'https://account/import?privatekey=K1'],
        ['unsupported scheme (ftp)', 'ftp://account/import?privatekey=K1'],
        ['wrong authority', 'avm://wallet/import?privatekey=K1'],
        ['wrong path', 'avm://account/export?privatekey=K1'],
        ['too few path segments', 'avm://account'],
        ['no key and no address', 'avm://account/import'],
        ['only checksum, no key/address', 'avm://account/import?checksum=x'],
        ['only address is empty-ish absent', 'avm://account/import?name=NoKey'],
      ];

      it.each(invalid)('%s -> null', (_label, uri) => {
        expect(parseArc0300AccountImportUri(uri)).toBeNull();
      });
    });

    // FIXED (TASK-104): `privatekey=` carries no key material, so the URI is
    // malformed and the correct result is null. The parser now filters out
    // empty/whitespace private-key values before the length check, so an empty
    // string no longer yields a bogus 'standard' entry — it falls through to
    // the watch/null path.
    it('rejects an empty private-key value', () => {
      expect(
        parseArc0300AccountImportUri('avm://account/import?privatekey=')
      ).toBeNull();
    });

    it('rejects a whitespace-only private-key value', () => {
      expect(
        parseArc0300AccountImportUri('avm://account/import?privatekey=%20')
      ).toBeNull();
    });

    it('drops a blank key without misaligning the remaining key/name pairs', () => {
      // A blank first key must not shift the valid second key onto the wrong
      // label: it should be dropped, and the valid key keeps its own name.
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=%20&name=Decoy&privatekey=K2&name=Actual'
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe('standard');
      expect(parsed!.entries).toEqual([
        { privateKeyBase64: 'K2', name: 'Actual' },
      ]);
    });

    it('falls through to a watch import when the only key is blank but an address is present', () => {
      const parsed = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=%20&address=ADDR'
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe('watch');
      expect(parsed!.entries).toEqual([{ address: 'ADDR' }]);
    });
  });

  describe('isArc0300AccountImportUri', () => {
    it('is true for a valid import URI', () => {
      expect(
        isArc0300AccountImportUri('avm://account/import?privatekey=K1')
      ).toBe(true);
    });

    it('is true for a generated export URI (round-trip recognition)', () => {
      const uri = generateArc0300AccountExportUri({
        privateKeyBytes: makeSecretKey(11),
        name: 'Acct',
      });
      expect(isArc0300AccountImportUri(uri)).toBe(true);
    });

    it('is false for unrelated / malformed URIs', () => {
      expect(isArc0300AccountImportUri('https://example.com')).toBe(false);
      expect(isArc0300AccountImportUri('avm://account/import')).toBe(false);
      expect(isArc0300AccountImportUri('')).toBe(false);
    });
  });

  describe('normalizeBase64ToHex', () => {
    it('hex-encodes a 64-byte secret key unchanged', () => {
      const sk = makeSecretKey(9);
      expect(normalizeBase64ToHex(toB64Url(sk))).toBe(hexOf(sk));
    });

    it('derives the full 64-byte secret key from a 32-byte seed', () => {
      const seed = makeSeed(7);
      const kp = nacl.sign.keyPair.fromSeed(seed);
      const hex = normalizeBase64ToHex(toB64Url(seed));

      expect(hex).toBe(hexOf(kp.secretKey));
      // Ed25519 secret key layout: first 32 bytes = seed, last 32 = public key.
      expect(hex.slice(0, 64)).toBe(hexOf(seed));
      expect(hex.slice(64)).toBe(hexOf(kp.publicKey));
    });

    it('decodes URL-safe base64 (handles - and _)', () => {
      const bytes = new Uint8Array(64).fill(0xfb); // std base64 has + and /
      const urlB64 = toB64Url(bytes);
      expect(urlB64).toMatch(/[-_]/);
      expect(urlB64).not.toMatch(/[+/]/);
      expect(normalizeBase64ToHex(urlB64)).toBe(hexOf(bytes));
    });

    it('adds the padding it needs to decode an unpadded 32-byte seed', () => {
      const seed = makeSeed(2);
      const unpadded = toB64Url(seed);
      expect(unpadded).not.toContain('=');
      expect(unpadded.length % 4).not.toBe(0); // proves padding is required
      expect(() => normalizeBase64ToHex(unpadded)).not.toThrow();
    });

    it('throws for an unsupported key length', () => {
      const sixteen = toB64Url(new Uint8Array(16));
      expect(() => normalizeBase64ToHex(sixteen)).toThrow(
        'Unsupported ARC-0300 private key length: 16 bytes'
      );
    });

    it('throws for an empty (0-byte) input', () => {
      expect(() => normalizeBase64ToHex('')).toThrow(
        'Unsupported ARC-0300 private key length: 0 bytes'
      );
    });
  });

  describe('collectArc0300Entries', () => {
    it('flattens entries across results while preserving kind', () => {
      const std = parseArc0300AccountImportUri(
        'avm://account/import?privatekey=K1&name=A&privatekey=K2&name=B'
      )!;
      const watch = parseArc0300AccountImportUri(
        'avm://account/import?address=ADDR'
      )!;

      const collected = collectArc0300Entries([std, watch]);

      expect(collected).toHaveLength(3);
      expect(collected[0]).toEqual({
        kind: 'standard',
        name: 'A',
        privateKeyBase64: 'K1',
        address: undefined,
      });
      expect(collected[1]).toEqual({
        kind: 'standard',
        name: 'B',
        privateKeyBase64: 'K2',
        address: undefined,
      });
      expect(collected[2]).toEqual({
        kind: 'watch',
        name: undefined,
        privateKeyBase64: undefined,
        address: 'ADDR',
      });
    });

    it('returns an empty array for no results', () => {
      expect(collectArc0300Entries([])).toEqual([]);
    });
  });

  describe('round-trip: generate -> parse -> normalizeBase64ToHex', () => {
    it('recovers the exact 64-byte secret key and name', () => {
      const sk = makeSecretKey(13);
      const uri = generateArc0300AccountExportUri({
        privateKeyBytes: sk,
        name: 'Air-Gapped Wallet',
      });

      const parsed = parseArc0300AccountImportUri(uri)!;
      expect(parsed.kind).toBe('standard');
      expect(parsed.scheme).toBe('avm');
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].name).toBe('Air-Gapped Wallet');

      const hex = normalizeBase64ToHex(parsed.entries[0].privateKeyBase64!);
      expect(hex).toBe(hexOf(sk));
    });

    it('tampered base64 payload decodes to a DIFFERENT key (negative test)', () => {
      const sk = makeSecretKey(21);
      const uri = generateArc0300AccountExportUri({ privateKeyBytes: sk });

      const start = uri.indexOf('privatekey=') + 'privatekey='.length;
      const ch = uri[start];
      const swapped = ch === 'A' ? 'B' : 'A'; // stays valid base64, same length
      const tampered = uri.slice(0, start) + swapped + uri.slice(start + 1);

      const parsed = parseArc0300AccountImportUri(tampered)!;
      const hex = normalizeBase64ToHex(parsed.entries[0].privateKeyBase64!);

      // Structurally still a valid import, but the recovered key must differ.
      expect(parsed.kind).toBe('standard');
      expect(hex).not.toBe(hexOf(sk));
    });

    it('seed derivation is sensitive to a single-byte change (crypto tamper)', () => {
      const hexA = normalizeBase64ToHex(toB64Url(makeSeed(1)));
      const hexB = normalizeBase64ToHex(toB64Url(makeSeed(2)));
      expect(hexA).not.toBe(hexB);
      // The derived public-key halves must also diverge.
      expect(hexA.slice(64)).not.toBe(hexB.slice(64));
    });
  });
});

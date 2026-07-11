import algosdk from 'algosdk';
import {
  isAlgorandPaymentUri,
  parseAlgorandUri,
  convertAmountToDisplay,
  createPaymentSummary,
  type AlgorandUriParams,
  type ParsedAlgorandUri,
} from '../algorandUri';

// A real, checksum-valid Algorand/Voi address generated at load time. algosdk
// 3.x returns `addr` as an Address object, so `.toString()` yields the 58-char
// base32 string the URI format expects.
const VALID_ADDRESS = algosdk.generateAccount().addr.toString();
// Tamper a character *inside* the payload so the checksum genuinely breaks.
// (Flipping the last base32 char can only alter padding bits and may still
// validate.) This is the "tampered input" negative for address crypto.
function makeInvalidAddress(addr: string): string {
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const i = 10; // well inside the 32-byte public key
  for (const c of base32) {
    if (c === addr[i]) continue;
    const candidate = addr.slice(0, i) + c + addr.slice(i + 1);
    if (!algosdk.isValidAddress(candidate)) return candidate;
  }
  return addr.slice(1); // practically unreachable fallback
}
const TAMPERED_ADDRESS = makeInvalidAddress(VALID_ADDRESS);

/**
 * Builds a URI string from parts using standard form-urlencoding (single
 * encode) so we can round-trip it through the parser. There is no build()
 * export in the module under test, so the "round-trip" is: assemble a
 * spec-correct URI here, parse it, and assert the parsed parts match.
 */
function buildUri(
  scheme: 'algorand' | 'voi' | 'perawallet',
  address: string,
  params: AlgorandUriParams = {}
): string {
  const qs = new URLSearchParams();
  if (params.amount !== undefined) qs.set('amount', params.amount);
  if (params.asset !== undefined) qs.set('asset', params.asset);
  if (params.label !== undefined) qs.set('label', params.label);
  if (params.note !== undefined) qs.set('note', params.note);
  if (params.xnote !== undefined) qs.set('xnote', params.xnote);
  if (params.address !== undefined) qs.set('address', params.address);
  const query = qs.toString();
  return `${scheme}://${address}${query ? `?${query}` : ''}`;
}

describe('algorandUri', () => {
  describe('isAlgorandPaymentUri', () => {
    it('accepts each supported scheme', () => {
      expect(isAlgorandPaymentUri(`algorand://${VALID_ADDRESS}`)).toBe(true);
      expect(isAlgorandPaymentUri(`voi://${VALID_ADDRESS}`)).toBe(true);
      expect(isAlgorandPaymentUri(`perawallet://${VALID_ADDRESS}`)).toBe(true);
    });

    it('is case-insensitive on the scheme', () => {
      expect(isAlgorandPaymentUri(`VOI://${VALID_ADDRESS}`)).toBe(true);
      expect(isAlgorandPaymentUri(`Algorand://${VALID_ADDRESS}`)).toBe(true);
      expect(isAlgorandPaymentUri(`PERAWALLET://${VALID_ADDRESS}`)).toBe(true);
    });

    it('rejects unrelated / malformed schemes', () => {
      expect(isAlgorandPaymentUri('https://example.com')).toBe(false);
      expect(isAlgorandPaymentUri('bitcoin:1abc')).toBe(false);
      expect(isAlgorandPaymentUri('algorand:no-slashes')).toBe(false);
      expect(isAlgorandPaymentUri('')).toBe(false);
      // "voi" appearing mid-string must not match a prefix check
      expect(isAlgorandPaymentUri('https://voi://x')).toBe(false);
    });
  });

  describe('parseAlgorandUri - scheme + address handling', () => {
    it('parses the address from the path for each scheme', () => {
      for (const scheme of ['algorand', 'voi', 'perawallet'] as const) {
        const parsed = parseAlgorandUri(`${scheme}://${VALID_ADDRESS}`);
        expect(parsed).not.toBeNull();
        expect(parsed!.scheme).toBe(scheme);
        expect(parsed!.address).toBe(VALID_ADDRESS);
        expect(parsed!.isValid).toBe(true);
        expect(parsed!.params).toEqual({});
      }
    });

    it('preserves address casing even when the scheme is uppercased', () => {
      const parsed = parseAlgorandUri(`VOI://${VALID_ADDRESS}`);
      expect(parsed).not.toBeNull();
      expect(parsed!.scheme).toBe('voi');
      // base32 addresses are case-sensitive; the slice must come off the
      // original (not lowercased) URI, otherwise the checksum breaks.
      expect(parsed!.address).toBe(VALID_ADDRESS);
      expect(parsed!.isValid).toBe(true);
    });

    it('returns null for unsupported schemes', () => {
      expect(parseAlgorandUri('https://example.com')).toBeNull();
      expect(parseAlgorandUri('bitcoin:1abc')).toBeNull();
      expect(parseAlgorandUri('')).toBeNull();
      expect(parseAlgorandUri('just some text')).toBeNull();
    });

    it('marks a checksum-invalid address as isValid:false but still returns an object', () => {
      const parsed = parseAlgorandUri(`voi://${TAMPERED_ADDRESS}`);
      expect(parsed).not.toBeNull();
      expect(parsed!.address).toBe(TAMPERED_ADDRESS);
      expect(parsed!.isValid).toBe(false);
      expect(parsed!.scheme).toBe('voi');
    });

    it('marks obvious garbage in the address slot as invalid', () => {
      const parsed = parseAlgorandUri('algorand://NOTAVALIDADDRESS');
      expect(parsed).not.toBeNull();
      expect(parsed!.isValid).toBe(false);
    });

    it('treats an empty address (asset opt-in style) as valid', () => {
      const parsed = parseAlgorandUri('voi://?amount=1000000');
      expect(parsed).not.toBeNull();
      expect(parsed!.address).toBe('');
      // No address to validate -> defaults to valid.
      expect(parsed!.isValid).toBe(true);
      expect(parsed!.params.amount).toBe('1000000');
    });

    it('falls back to the ?address= query param when the path is empty', () => {
      const uri = buildUri('voi', '', {
        address: VALID_ADDRESS,
        amount: '500000',
      });
      const parsed = parseAlgorandUri(uri);
      expect(parsed).not.toBeNull();
      expect(parsed!.address).toBe(VALID_ADDRESS);
      expect(parsed!.params.address).toBe(VALID_ADDRESS);
      expect(parsed!.isValid).toBe(true);
    });
  });

  describe('parseAlgorandUri - round-trips', () => {
    it('round-trips a full native-token payment request', () => {
      const params: AlgorandUriParams = {
        amount: '1500000',
        label: 'Alice Smith',
        note: 'coffee money',
        xnote: 'immutable receipt',
      };
      const uri = buildUri('voi', VALID_ADDRESS, params);
      const parsed = parseAlgorandUri(uri);

      expect(parsed).not.toBeNull();
      expect(parsed!.address).toBe(VALID_ADDRESS);
      expect(parsed!.scheme).toBe('voi');
      expect(parsed!.isValid).toBe(true);
      expect(parsed!.params.amount).toBe('1500000');
      expect(parsed!.params.label).toBe('Alice Smith');
      expect(parsed!.params.note).toBe('coffee money');
      expect(parsed!.params.xnote).toBe('immutable receipt');
      // asset omitted -> undefined (native token)
      expect(parsed!.params.asset).toBeUndefined();
    });

    it('round-trips an ASA (asset) payment request', () => {
      const params: AlgorandUriParams = { amount: '250', asset: '12345' };
      const uri = buildUri('algorand', VALID_ADDRESS, params);
      const parsed = parseAlgorandUri(uri);

      expect(parsed).not.toBeNull();
      expect(parsed!.params.amount).toBe('250');
      expect(parsed!.params.asset).toBe('12345');
      expect(parsed!.scheme).toBe('algorand');
    });

    it('round-trips unicode and reserved characters in the label', () => {
      const params: AlgorandUriParams = { label: 'Café & Bar' };
      const uri = buildUri('voi', VALID_ADDRESS, params);
      const parsed = parseAlgorandUri(uri);

      expect(parsed).not.toBeNull();
      // These survive because after a single decode no '%' remains.
      expect(parsed!.params.label).toBe('Café & Bar');
    });
  });

  describe('parseAlgorandUri - amount validation', () => {
    it('accepts a valid non-negative integer amount', () => {
      expect(
        parseAlgorandUri(buildUri('voi', VALID_ADDRESS, { amount: '0' }))!
          .params.amount
      ).toBe('0');
      expect(
        parseAlgorandUri(buildUri('voi', VALID_ADDRESS, { amount: '1000000' }))!
          .params.amount
      ).toBe('1000000');
    });

    it('accepts the exact upper bound (1e16)', () => {
      const parsed = parseAlgorandUri(
        buildUri('voi', VALID_ADDRESS, { amount: '10000000000000000' })
      );
      expect(parsed!.params.amount).toBe('10000000000000000');
    });

    it('drops an amount over the deliberate upper bound (native total supply)', () => {
      // The parser caps amount at 1e16 base units — VOI/ALGO total supply
      // (10B * 1e6 microunits) — as a documented sanity bound (not a URI-spec
      // requirement). NOTE: this native bound can be below a high-supply ASA's
      // max valid amount; whether the cap should be asset-aware (or uint64-max)
      // is tracked separately.
      const parsed = parseAlgorandUri(
        buildUri('voi', VALID_ADDRESS, { amount: '10000000000000001' })
      );
      expect(parsed!.params.amount).toBeUndefined();
    });

    it('drops non-integer / negative / non-numeric amounts', () => {
      for (const bad of ['-100', '1.5', '1e6', 'abc', '0x10', '  5  ']) {
        const parsed = parseAlgorandUri(
          buildUri('voi', VALID_ADDRESS, { amount: bad })
        );
        expect(parsed!.params.amount).toBeUndefined();
      }
    });
  });

  describe('parseAlgorandUri - asset validation', () => {
    it('accepts a positive integer asset id', () => {
      const parsed = parseAlgorandUri(
        buildUri('voi', VALID_ADDRESS, { asset: '31566704' })
      );
      expect(parsed!.params.asset).toBe('31566704');
    });

    it('drops asset id 0 (native token is represented by omission)', () => {
      const parsed = parseAlgorandUri(
        buildUri('voi', VALID_ADDRESS, { asset: '0' })
      );
      expect(parsed!.params.asset).toBeUndefined();
    });

    it('drops negative / non-numeric asset ids', () => {
      for (const bad of ['-1', 'abc', '1.5', '']) {
        const parsed = parseAlgorandUri(
          buildUri('voi', VALID_ADDRESS, { asset: bad })
        );
        expect(parsed!.params.asset).toBeUndefined();
      }
    });
  });

  describe('parseAlgorandUri - note/label decoding (double-decode bug)', () => {
    // KNOWN BUG (tracked): parseAlgorandUri decodes twice — URLSearchParams
    // already percent-decodes, then decodeURIComponent runs again. For a note
    // with a literal '%', the second decode throws URIError on the leftover '%'
    // and the whole parse returns null, rejecting a valid payment URI.
    // it.failing asserts the CORRECT behavior (passes while buggy; flips when fixed).
    it.failing('preserves a note containing a literal percent sign', () => {
      const uri = buildUri('voi', VALID_ADDRESS, { note: '100%' });
      expect(uri).toContain('note=100%25'); // encoded exactly once
      const parsed = parseAlgorandUri(uri);
      expect(parsed).not.toBeNull();
      expect(parsed!.params.note).toBe('100%');
    });

    // KNOWN BUG (tracked, same double-decode): a label whose literal text is the
    // 3 chars "%41" is correctly encoded "%2541"; one decode restores "%41", but
    // the second decode corrupts it to "A".
    it.failing(
      'does not corrupt a label that is literally a percent escape',
      () => {
        const uri = buildUri('voi', VALID_ADDRESS, { label: '%41' });
        expect(uri).toContain('label=%2541');
        const parsed = parseAlgorandUri(uri);
        expect(parsed!.params.label).toBe('%41');
      }
    );
  });

  describe('convertAmountToDisplay', () => {
    it('converts whole microVOI/microAlgos amounts (default 6 decimals)', () => {
      expect(convertAmountToDisplay('1000000')).toBe('1');
      expect(convertAmountToDisplay('10000000000000000')).toBe('10000000000');
      expect(convertAmountToDisplay('0')).toBe('0');
    });

    it('formats fractional amounts and trims trailing zeros', () => {
      expect(convertAmountToDisplay('1500000')).toBe('1.5');
      expect(convertAmountToDisplay('1234567')).toBe('1.234567');
      expect(convertAmountToDisplay('500000')).toBe('0.5');
      expect(convertAmountToDisplay('1200000')).toBe('1.2');
    });

    it('pads leading fractional zeros correctly (no trailing zeros to trim)', () => {
      expect(convertAmountToDisplay('1')).toBe('0.000001');
      expect(convertAmountToDisplay('1000001')).toBe('1.000001');
      expect(convertAmountToDisplay('1000010')).toBe('1.00001');
    });

    it('honours a custom decimals argument', () => {
      expect(convertAmountToDisplay('100', 0)).toBe('100');
      expect(convertAmountToDisplay('123', 2)).toBe('1.23');
      expect(convertAmountToDisplay('120', 2)).toBe('1.2');
      expect(convertAmountToDisplay('1', 2)).toBe('0.01');
    });

    it('returns "0" for un-parseable input instead of throwing', () => {
      expect(convertAmountToDisplay('not-a-number')).toBe('0');
      expect(convertAmountToDisplay('1.5')).toBe('0');
    });
  });

  describe('createPaymentSummary', () => {
    const base = (over: Partial<ParsedAlgorandUri>): ParsedAlgorandUri => ({
      address: VALID_ADDRESS,
      params: {},
      isValid: true,
      scheme: 'voi',
      ...over,
    });

    it('prefers the label over the truncated address', () => {
      const summary = createPaymentSummary(
        base({ params: { label: 'Alice', amount: '1000000' } })
      );
      expect(summary).toBe('Send to Alice 1 VOI');
    });

    it('truncates the address to first-8...last-8 when there is no label', () => {
      const summary = createPaymentSummary(
        base({ params: { amount: '2500000' } })
      );
      const short = `${VALID_ADDRESS.slice(0, 8)}...${VALID_ADDRESS.slice(-8)}`;
      expect(summary).toBe(`Send to ${short} 2.5 VOI`);
    });

    it('labels the native token "Algos" for the algorand scheme', () => {
      const summary = createPaymentSummary(
        base({
          scheme: 'algorand',
          params: { amount: '1000000', label: 'Bob' },
        })
      );
      expect(summary).toBe('Send to Bob 1 Algos');
    });

    it('labels the native token "VOI" for the perawallet scheme', () => {
      const summary = createPaymentSummary(
        base({
          scheme: 'perawallet',
          params: { amount: '3000000', label: 'Bo' },
        })
      );
      expect(summary).toBe('Send to Bo 3 VOI');
    });

    it('describes an ASA amount with 0 decimals and the asset id', () => {
      const summary = createPaymentSummary(
        base({ params: { amount: '250', asset: '12345', label: 'Eve' } })
      );
      expect(summary).toBe('Send to Eve 250 units of asset 12345');
    });

    it('prefers xnote over note in the summary', () => {
      const summary = createPaymentSummary(
        base({ params: { label: 'Al', note: 'mutable', xnote: 'locked' } })
      );
      expect(summary).toBe('Send to Al with note: "locked"');
    });

    it('uses note when xnote is absent', () => {
      const summary = createPaymentSummary(
        base({ params: { label: 'Al', note: 'thanks' } })
      );
      expect(summary).toBe('Send to Al with note: "thanks"');
    });

    it('falls back to a generic message when there is nothing to summarise', () => {
      const summary = createPaymentSummary(base({ address: '', params: {} }));
      expect(summary).toBe('Process payment request');
    });

    it('combines label, amount and note into one sentence', () => {
      const summary = createPaymentSummary(
        base({ params: { label: 'Alice', amount: '1500000', note: 'hi' } })
      );
      expect(summary).toBe('Send to Alice 1.5 VOI with note: "hi"');
    });
  });
});

import algosdk from 'algosdk';

// --- Mock BOTH services so ONLY the pure address logic runs. ---------------
// No live Envoi resolution, no live network calls. isFeatureAvailable /
// isValidNameFormat are pure synchronous gates we can steer per-test; the
// getName/getAddress resolvers exist but we never exercise real resolution.
jest.mock('@/services/network', () => ({
  __esModule: true,
  default: { isFeatureAvailable: jest.fn(() => false) },
}));

jest.mock('@/services/envoi', () => {
  const instance = { getName: jest.fn(), getAddress: jest.fn() };
  return {
    __esModule: true,
    default: {
      getInstance: jest.fn(() => instance),
      isValidNameFormat: jest.fn(() => false),
    },
  };
});

import {
  formatAddress,
  formatAddressSync,
  formatAddressWithName,
  resolveAddressOrName,
  isLikelyEnvoiName,
  clearFormatCache,
} from '../address';
import VoiNetworkService from '@/services/network';
import EnvoiService from '@/services/envoi';

const mockNetwork = VoiNetworkService as unknown as {
  isFeatureAvailable: jest.Mock;
};
const mockEnvoi = EnvoiService as unknown as {
  getInstance: jest.Mock;
  isValidNameFormat: jest.Mock;
};
const envoiInstance = mockEnvoi.getInstance() as unknown as {
  getName: jest.Mock;
  getAddress: jest.Mock;
};

// A fixed, known-valid 58-char Algorand address. Truncations below are
// hand-computed from the base32 string, NOT read back from the function.
const KNOWN = '7ZUECA7HFLZTXENRV24SHLU4AVPUTMTTDUFUBNBD64C73F3UHRTHAIOF6Q';
const KNOWN_TRUNC_6_4 = '7ZUECA...OF6Q'; // slice(0,6) + '...' + slice(-4)
const KNOWN_TRUNC_4_6 = '7ZUE...AIOF6Q'; // slice(0,4) + '...' + slice(-6)
// Tampered: flip the final base32 char -> checksum breaks -> invalid address.
const TAMPERED = KNOWN.slice(0, 57) + 'A';

// A fresh, real, cryptographically-valid address for each call.
const genAddr = (): string => algosdk.generateAccount().addr.toString();

beforeEach(() => {
  // clearMocks (jest config) wipes call data but NOT implementations, so we
  // re-pin the default gates every test to avoid leakage between tests.
  clearFormatCache();
  mockNetwork.isFeatureAvailable.mockReset().mockReturnValue(false);
  mockEnvoi.isValidNameFormat.mockReset().mockReturnValue(false);
  envoiInstance.getName.mockReset();
  envoiInstance.getAddress.mockReset();
});

describe('address utils — fixtures sanity', () => {
  it('KNOWN is a valid 58-char address and TAMPERED is not', () => {
    expect(KNOWN).toHaveLength(58);
    expect(algosdk.isValidAddress(KNOWN)).toBe(true);
    expect(TAMPERED).toHaveLength(58);
    expect(algosdk.isValidAddress(TAMPERED)).toBe(false);
  });
});

describe('formatAddress', () => {
  it('truncates a known valid address to <first6>...<last4>', () => {
    expect(formatAddress(KNOWN)).toBe(KNOWN_TRUNC_6_4);
  });

  it('honours custom prefix/suffix lengths', () => {
    expect(formatAddress(KNOWN, 4, 6)).toBe(KNOWN_TRUNC_4_6);
  });

  it('truncates any generated valid address consistently', () => {
    const addr = genAddr();
    const out = formatAddress(addr);
    // Spec: keep the first 6 and last 4 base32 chars, joined by an ellipsis.
    expect(out).toBe(`${addr.slice(0, 6)}...${addr.slice(-4)}`);
    expect(out).toHaveLength(6 + 3 + 4); // 13
    expect(out.startsWith(addr.slice(0, 6))).toBe(true);
    expect(out.endsWith(addr.slice(-4))).toBe(true);
  });

  it('returns "Invalid Address" for empty / nullish input', () => {
    expect(formatAddress('')).toBe('Invalid Address');
    expect(formatAddress(undefined as unknown as string)).toBe(
      'Invalid Address'
    );
    expect(formatAddress(null as unknown as string)).toBe('Invalid Address');
  });

  it('echoes a non-empty but invalid string verbatim', () => {
    // Guard is `address || "Invalid Address"`, so a present-but-invalid value
    // is returned as typed (used to echo user input in the UI).
    expect(formatAddress('not-an-address')).toBe('not-an-address');
  });

  it('does NOT truncate a tampered (checksum-broken) address', () => {
    // Crypto negative case: an address whose checksum was flipped is invalid,
    // so it must NOT be treated/truncated as a real address.
    expect(formatAddress(TAMPERED)).toBe(TAMPERED);
    expect(formatAddress(TAMPERED)).not.toBe(KNOWN_TRUNC_6_4);
  });
});

describe('formatAddressSync', () => {
  it('shortens a valid address when there is no name', () => {
    const addr = genAddr();
    const res = formatAddressSync(addr);
    expect(res.displayText).toBe(`${addr.slice(0, 6)}...${addr.slice(-4)}`);
    expect(res.fullAddress).toBe(addr);
    expect(res.hasName).toBe(false);
    expect(res.envoiName).toBeUndefined();
  });

  it('honours custom prefix/suffix', () => {
    expect(
      formatAddressSync(KNOWN, null, { prefixLength: 4, suffixLength: 6 })
    ).toMatchObject({ displayText: KNOWN_TRUNC_4_6, fullAddress: KNOWN });
  });

  it('shows the full address when showFullAddress is set', () => {
    const res = formatAddressSync(KNOWN, null, { showFullAddress: true });
    expect(res.displayText).toBe(KNOWN);
    expect(res.hasName).toBe(false);
  });

  it('prefers the Envoi name over truncation when a name is supplied', () => {
    const addr = genAddr();
    const res = formatAddressSync(addr, { name: 'alice.voi' } as never);
    expect(res.displayText).toBe('alice.voi');
    expect(res.envoiName).toBe('alice.voi');
    expect(res.hasName).toBe(true);
    expect(res.fullAddress).toBe(addr);
  });

  it('name wins even over showFullAddress', () => {
    const res = formatAddressSync(KNOWN, { name: 'bob.voi' } as never, {
      showFullAddress: true,
    });
    expect(res.displayText).toBe('bob.voi');
    expect(res.hasName).toBe(true);
  });

  it('treats an empty name as "no name" and falls back to truncation', () => {
    const res = formatAddressSync(KNOWN, { name: '' } as never);
    expect(res.displayText).toBe(KNOWN_TRUNC_6_4);
    expect(res.hasName).toBe(false);
  });

  it('reports invalid input without a name', () => {
    const empty = formatAddressSync('');
    expect(empty).toEqual({
      displayText: 'Invalid Address',
      fullAddress: '',
      hasName: false,
    });

    const bad = formatAddressSync('not-an-address');
    expect(bad.displayText).toBe('not-an-address');
    expect(bad.fullAddress).toBe('not-an-address');
    expect(bad.hasName).toBe(false);
  });

  it('does not shorten a tampered address (crypto negative case)', () => {
    const res = formatAddressSync(TAMPERED);
    expect(res.displayText).toBe(TAMPERED);
    expect(res.hasName).toBe(false);
  });
});

describe('formatAddressWithName (Envoi feature OFF => pure formatting)', () => {
  it('shortens a valid address and never touches Envoi when the feature is off', async () => {
    const addr = genAddr();
    const res = await formatAddressWithName(addr);
    expect(res).toMatchObject({
      displayText: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
      fullAddress: addr,
      hasName: false,
    });
    expect(res.envoiName).toBeUndefined();
    expect(envoiInstance.getName).not.toHaveBeenCalled();
  });

  it('returns a frozen result object', async () => {
    const res = await formatAddressWithName(genAddr());
    expect(Object.isFrozen(res)).toBe(true);
  });

  it('returns a STABLE reference for identical inputs (cache hit)', async () => {
    const addr = genAddr();
    const a = await formatAddressWithName(addr);
    const b = await formatAddressWithName(addr);
    expect(b).toBe(a); // same object reference, not just equal
  });

  it('caches per-options: different options => different object, correct text', async () => {
    const a = await formatAddressWithName(KNOWN);
    const b = await formatAddressWithName(KNOWN, {
      prefixLength: 4,
      suffixLength: 6,
    });
    expect(b).not.toBe(a);
    expect(a.displayText).toBe(KNOWN_TRUNC_6_4);
    expect(b.displayText).toBe(KNOWN_TRUNC_4_6);
  });

  it('short-circuits invalid input before any feature/service check', async () => {
    mockNetwork.isFeatureAvailable.mockReturnValue(true); // even if enabled...
    const res = await formatAddressWithName('not-an-address');
    expect(res).toMatchObject({
      displayText: 'not-an-address',
      fullAddress: 'not-an-address',
      hasName: false,
    });
    // ...validation returns first, so the resolver is never consulted.
    expect(envoiInstance.getName).not.toHaveBeenCalled();
  });
});

describe('formatAddressWithName (Envoi feature ON, resolver mocked)', () => {
  it('uses the resolved Envoi name as the display text', async () => {
    const addr = genAddr();
    mockNetwork.isFeatureAvailable.mockReturnValue(true);
    envoiInstance.getName.mockResolvedValue({
      name: 'carol.voi',
      address: addr,
    });

    const res = await formatAddressWithName(addr);

    expect(envoiInstance.getName).toHaveBeenCalledWith(addr);
    expect(res.displayText).toBe('carol.voi');
    expect(res.envoiName).toBe('carol.voi');
    expect(res.hasName).toBe(true);
    expect(res.fullAddress).toBe(addr);
  });

  it('falls back to truncation when the resolver returns no name', async () => {
    const addr = genAddr();
    mockNetwork.isFeatureAvailable.mockReturnValue(true);
    envoiInstance.getName.mockResolvedValue(null);

    const res = await formatAddressWithName(addr);
    expect(res.displayText).toBe(`${addr.slice(0, 6)}...${addr.slice(-4)}`);
    expect(res.hasName).toBe(false);
  });
});

describe('clearFormatCache', () => {
  it('drops cached references so the next call rebuilds the object', async () => {
    const addr = genAddr();
    const first = await formatAddressWithName(addr);
    clearFormatCache();
    const second = await formatAddressWithName(addr);
    expect(second).not.toBe(first); // new object after clear
    expect(second).toEqual(first); // but identical content
  });
});

describe('resolveAddressOrName (pure / short-circuit branches only)', () => {
  it('returns a valid address as-is without hitting the resolver', async () => {
    const addr = genAddr();
    await expect(resolveAddressOrName(addr)).resolves.toBe(addr);
    expect(envoiInstance.getAddress).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace before returning a valid address', async () => {
    const addr = genAddr();
    await expect(resolveAddressOrName(`  ${addr}\n`)).resolves.toBe(addr);
  });

  it('returns null for empty / whitespace / nullish input', async () => {
    await expect(resolveAddressOrName('')).resolves.toBeNull();
    await expect(resolveAddressOrName('   ')).resolves.toBeNull();
    await expect(
      resolveAddressOrName(undefined as unknown as string)
    ).resolves.toBeNull();
  });

  it('returns null for a non-address when Envoi is disabled', async () => {
    mockNetwork.isFeatureAvailable.mockReturnValue(false);
    await expect(resolveAddressOrName('nope')).resolves.toBeNull();
    expect(envoiInstance.getAddress).not.toHaveBeenCalled();
  });
});

describe('isLikelyEnvoiName (branch logic only)', () => {
  it('is false for empty / nullish input', () => {
    expect(isLikelyEnvoiName('')).toBe(false);
    expect(isLikelyEnvoiName('   ')).toBe(false);
    expect(isLikelyEnvoiName(undefined as unknown as string)).toBe(false);
  });

  it('is false whenever the Envoi feature is disabled', () => {
    mockNetwork.isFeatureAvailable.mockReturnValue(false);
    mockEnvoi.isValidNameFormat.mockReturnValue(true); // would-be name...
    expect(isLikelyEnvoiName('alice.voi')).toBe(false); // ...still false
  });

  it('is false for a valid address even when the feature is enabled', () => {
    mockNetwork.isFeatureAvailable.mockReturnValue(true);
    expect(isLikelyEnvoiName(KNOWN)).toBe(false);
  });

  it('defers to Envoi name-format check when the feature is enabled', () => {
    mockNetwork.isFeatureAvailable.mockReturnValue(true);

    mockEnvoi.isValidNameFormat.mockReturnValue(true);
    expect(isLikelyEnvoiName('alice.voi')).toBe(true);

    mockEnvoi.isValidNameFormat.mockReturnValue(false);
    expect(isLikelyEnvoiName('alice.voi')).toBe(false);
  });
});

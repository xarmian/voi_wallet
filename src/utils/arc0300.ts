import { Buffer } from 'buffer';
import nacl from 'tweetnacl';

const ARC0300_SCHEMES = new Set(['avm', 'algorand']);
const ARC0300_ACCOUNT_AUTHORITY = 'account';
const ARC0300_IMPORT_PATH = 'import';

export interface Arc0300Pagination {
  index: number;
  total: number;
}

export interface Arc0300AccountImportResult {
  kind: 'standard' | 'watch';
  entries: Array<{
    privateKeyBase64?: string;
    name?: string;
    address?: string;
  }>;
  pagination?: Arc0300Pagination;
  checksum?: string;
  scheme: string;
}

function normalizeScheme(uri: string): { scheme: string | null; rest: string } {
  const schemeMatch = uri.match(/^([^:]+):\/\/(.+)$/);
  if (!schemeMatch) {
    return { scheme: null, rest: uri };
  }
  return { scheme: schemeMatch[1].toLowerCase(), rest: schemeMatch[2] };
}

function splitPathAndQuery(rest: string): {
  pathSegments: string[];
  query: URLSearchParams;
} {
  const [pathPart, queryPart = ''] = rest.split('?');
  const pathSegments = pathPart.split('/').filter(Boolean);
  return {
    pathSegments,
    query: new URLSearchParams(queryPart),
  };
}

export function parseArc0300AccountImportUri(
  uri: string
): Arc0300AccountImportResult | null {
  const { scheme, rest } = normalizeScheme(uri.trim());

  if (!scheme || !ARC0300_SCHEMES.has(scheme)) {
    return null;
  }

  const { pathSegments, query } = splitPathAndQuery(rest);

  if (pathSegments.length < 2) {
    return null;
  }

  const [authority, path] = pathSegments;

  if (authority !== ARC0300_ACCOUNT_AUTHORITY || path !== ARC0300_IMPORT_PATH) {
    return null;
  }

  const privateKeys = query.getAll('privatekey');
  const names = query.getAll('name');
  const addresses = query.getAll('address');
  const checksum = query.get('checksum') || undefined;
  const pageParam = query.get('page') || undefined;

  let pagination: Arc0300Pagination | undefined;
  if (pageParam) {
    const [indexStr, totalStr] = pageParam.split(':');
    const index = Number.parseInt(indexStr ?? '', 10);
    const total = Number.parseInt(totalStr ?? '', 10);
    if (Number.isInteger(index) && Number.isInteger(total) && total > 0) {
      pagination = { index, total };
    }
  }

  if (privateKeys.length > 0) {
    return {
      kind: 'standard',
      entries: privateKeys.map((value, idx) => ({
        privateKeyBase64: value.trim(),
        name: names[idx],
      })),
      pagination,
      checksum,
      scheme,
    };
  }

  if (addresses.length > 0) {
    return {
      kind: 'watch',
      entries: addresses.map((address) => ({ address })),
      pagination,
      checksum,
      scheme,
    };
  }

  return null;
}

export function normalizeBase64ToHex(base64: string): string {
  let normalized = base64.replace(/-/g, '+').replace(/_/g, '/');

  const pad = normalized.length % 4;
  if (pad > 0) {
    normalized = normalized.padEnd(normalized.length + (4 - pad), '=');
  }

  const decoded = Buffer.from(normalized, 'base64');

  if (decoded.length === 64) {
    return Buffer.from(decoded).toString('hex');
  }

  if (decoded.length === 32) {
    const seed = new Uint8Array(decoded);
    const { secretKey } = nacl.sign.keyPair.fromSeed(seed);

    return Buffer.from(secretKey).toString('hex');
  }

  throw new Error(
    `Unsupported ARC-0300 private key length: ${decoded.length} bytes`
  );
}

export function collectArc0300Entries(
  order: Arc0300AccountImportResult[]
): Array<{
  name?: string;
  privateKeyBase64?: string;
  address?: string;
  kind: 'standard' | 'watch';
}> {
  return order.flatMap((result) =>
    result.entries.map((entry) => ({
      kind: result.kind,
      name: entry.name,
      privateKeyBase64: entry.privateKeyBase64,
      address: entry.address,
    }))
  );
}

export function isArc0300AccountImportUri(uri: string): boolean {
  return parseArc0300AccountImportUri(uri) !== null;
}

/**
 * Generate an ARC-0300 account export URI containing a private key.
 * Used for transferring an account to an air-gapped device.
 *
 * @param params.privateKeyBytes - The 64-byte Ed25519 secret key
 * @param params.name - Optional account name/label
 * @returns ARC-0300 URI string (e.g., avm://account/import?privatekey=<base64>&name=<name>)
 */
export function generateArc0300AccountExportUri(params: {
  privateKeyBytes: Uint8Array;
  name?: string;
}): string {
  const { privateKeyBytes, name } = params;

  // Validate key length (should be 64 bytes for Ed25519 secret key)
  if (privateKeyBytes.length !== 64) {
    throw new Error(
      `Invalid private key length: expected 64 bytes, got ${privateKeyBytes.length}`
    );
  }

  // Convert to URL-safe base64 (RFC 4648 §5)
  // Replace + with -, / with _, and remove padding =
  const privateKeyBase64 = Buffer.from(privateKeyBytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Build the URI
  let uri = `avm://account/import?privatekey=${privateKeyBase64}`;

  if (name) {
    uri += `&name=${encodeURIComponent(name)}`;
  }

  return uri;
}

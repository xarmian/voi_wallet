const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

const KNOWN_IPFS_GATEWAY_PREFIXES = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

const IPFS_SCHEME_PREFIX = 'ipfs://';

const trimHash = (value: string) => {
  const hashIndex = value.indexOf('#');
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
};

const trimLeadingSlash = (value: string) => value.replace(/^\/+/, '');

const normalizeIpfsPath = (value: string) => {
  if (!value) {
    return undefined;
  }

  let path = value;

  if (path.startsWith(IPFS_SCHEME_PREFIX)) {
    path = path.slice(IPFS_SCHEME_PREFIX.length);
  }

  path = trimLeadingSlash(path);
  // Some URIs include a redundant ipfs/ prefix (e.g. ipfs://ipfs/<cid>)
  path = path.replace(/^ipfs\//i, '');

  // Preserve query parameters but drop fragments like #arc3
  const hashTrimmed = trimHash(path);
  const queryIndex = hashTrimmed.indexOf('?');
  if (queryIndex >= 0) {
    const base = hashTrimmed.slice(0, queryIndex);
    const query = hashTrimmed.slice(queryIndex);
    return `${DEFAULT_IPFS_GATEWAY}${base}${query}`;
  }

  return `${DEFAULT_IPFS_GATEWAY}${hashTrimmed}`;
};

const isIpfsGatewayUrl = (url: string) =>
  KNOWN_IPFS_GATEWAY_PREFIXES.some((prefix) =>
    url.toLowerCase().startsWith(prefix)
  );

const computeImagePriority = (rawUrl: string, normalizedUrl: string): number => {
  const raw = rawUrl.trim().toLowerCase();
  const normalized = normalizedUrl.trim().toLowerCase();

  if (raw.startsWith('https://')) {
    return isIpfsGatewayUrl(normalized) ? 3 : 4;
  }

  if (raw.startsWith('http://')) {
    return isIpfsGatewayUrl(normalized) ? 2 : 3;
  }

  if (raw.startsWith(IPFS_SCHEME_PREFIX)) {
    return 2;
  }

  return 1;
};

/**
 * Normalize an asset image URL so it can be loaded by React Native.
 * Converts IPFS URIs to an HTTPS gateway and removes fragments like #arc3.
 */
export const normalizeAssetImageUrl = (
  url?: string | null
): string | undefined => {
  if (!url || typeof url !== 'string') {
    return undefined;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith(IPFS_SCHEME_PREFIX)) {
    return normalizeIpfsPath(trimmed);
  }

  try {
    const parsed = new URL(trimmed);

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      // Fragments are not sent to the server but can confuse some loaders
      parsed.hash = '';
      return parsed.toString();
    }
  } catch (error) {
    // Ignore invalid URLs and fall through to undefined
  }

  return undefined;
};

/**
 * Pick the best available asset image URL from a list of candidates.
 * Prefers direct HTTPS URLs, then HTTP, then IPFS gateways.
 */
export const selectBestAssetImageUrl = (
  urls: Array<string | undefined | null>
): string | undefined => {
  let bestUrl: string | undefined;
  let bestPriority = -1;

  for (const candidate of urls) {
    if (!candidate) {
      continue;
    }

    const normalized = normalizeAssetImageUrl(candidate);
    if (!normalized) {
      continue;
    }

    const priority = computeImagePriority(candidate, normalized);
    if (priority > bestPriority) {
      bestPriority = priority;
      bestUrl = normalized;
    }
  }

  return bestUrl;
};

export const __TESTING__ = {
  normalizeIpfsPath,
  computeImagePriority,
  isIpfsGatewayUrl,
};


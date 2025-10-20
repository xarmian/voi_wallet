import algosdk from 'algosdk';

export interface AlgorandUriParams {
  address?: string;
  amount?: string; // In smallest units (microVOI/microAlgos)
  asset?: string; // Asset ID, omit for native token
  label?: string; // Receiver's name/identifier
  note?: string; // Modifiable note
  xnote?: string; // Non-modifiable note
}

export interface ParsedAlgorandUri {
  address: string;
  params: AlgorandUriParams;
  isValid: boolean;
  scheme: 'algorand' | 'voi' | 'perawallet';
}

/**
 * Checks if a URI follows the Algorand payment prompt format
 * Supports algorand://, voi://, and perawallet:// schemes
 */
export function isAlgorandPaymentUri(uri: string): boolean {
  const normalizedUri = uri.toLowerCase();
  return (
    normalizedUri.startsWith('algorand://') ||
    normalizedUri.startsWith('voi://') ||
    normalizedUri.startsWith('perawallet://')
  );
}

/**
 * Parses an Algorand payment prompt URI
 * Format: algorand://{address}?{parameters}, voi://{address}?{parameters}, or perawallet://{address}?{parameters}
 */
export function parseAlgorandUri(uri: string): ParsedAlgorandUri | null {
  try {
    const normalizedUri = uri.toLowerCase();

    // Determine scheme
    let scheme: 'algorand' | 'voi' | 'perawallet';
    let withoutScheme: string;

    if (normalizedUri.startsWith('algorand://')) {
      scheme = 'algorand';
      withoutScheme = uri.slice(11); // Remove 'algorand://'
    } else if (normalizedUri.startsWith('voi://')) {
      scheme = 'voi';
      withoutScheme = uri.slice(6); // Remove 'voi://'
    } else if (normalizedUri.startsWith('perawallet://')) {
      scheme = 'perawallet';
      withoutScheme = uri.slice(13); // Remove 'perawallet://'
    } else {
      return null;
    }

    // Split address and parameters
    const [addressPart, paramsPart] = withoutScheme.split('?');

    // Address is optional in the URI (for asset opt-in)
    const address = addressPart || '';

    // Parse parameters
    const params: AlgorandUriParams = {};

    if (paramsPart) {
      const searchParams = new URLSearchParams(paramsPart);

      // Extract supported parameters
      if (searchParams.has('address')) {
        params.address = searchParams.get('address')!;
      }

      if (searchParams.has('amount')) {
        const amount = searchParams.get('amount')!;
        // Validate amount is a non-negative integer with reasonable upper bound
        if (/^\d+$/.test(amount)) {
          const amountValue = BigInt(amount);
          // Check reasonable upper bound (max 10B tokens with 6 decimals)
          if (amountValue <= BigInt('10000000000000000')) {
            params.amount = amount;
          }
        }
      }

      if (searchParams.has('asset')) {
        const asset = searchParams.get('asset')!;
        // Validate asset ID is a positive integer
        if (/^\d+$/.test(asset) && parseInt(asset) > 0) {
          params.asset = asset;
        }
      }

      if (searchParams.has('label')) {
        params.label = decodeURIComponent(searchParams.get('label')!);
      }

      if (searchParams.has('note')) {
        params.note = decodeURIComponent(searchParams.get('note')!);
      }

      if (searchParams.has('xnote')) {
        params.xnote = decodeURIComponent(searchParams.get('xnote')!);
      }
    }

    // Use address from path or address parameter
    const finalAddress = address || params.address || '';

    // Validate address format if provided using algosdk
    let isValidAddress = true;
    if (finalAddress) {
      try {
        isValidAddress = algosdk.isValidAddress(finalAddress);
      } catch (error) {
        console.error('Address validation error:', error);
        isValidAddress = false;
      }
    }

    return {
      address: finalAddress,
      params,
      isValid: isValidAddress,
      scheme,
    };
  } catch (error) {
    console.error('Failed to parse Algorand URI:', error);
    return null;
  }
}

/**
 * Converts amount from smallest units to display format
 * For VOI/Algos: microVOI/microAlgos to VOI/Algos (divide by 1,000,000)
 * For assets: uses asset decimals
 */
export function convertAmountToDisplay(
  amount: string,
  decimals: number = 6
): string {
  try {
    const amountBigInt = BigInt(amount);
    // Use BigInt exponentiation to avoid precision issues
    const divisor = BigInt(10) ** BigInt(decimals);

    // Calculate whole and fractional parts
    const wholePart = amountBigInt / divisor;
    const fractionalPart = amountBigInt % divisor;

    if (fractionalPart === BigInt(0)) {
      return wholePart.toString();
    }

    // Format fractional part with proper decimals
    const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
    const trimmedFractional = fractionalStr.replace(/0+$/, ''); // Remove trailing zeros

    return `${wholePart}.${trimmedFractional}`;
  } catch (error) {
    console.error('Failed to convert amount:', error);
    return '0';
  }
}

/**
 * Creates a human-readable summary of the payment request
 */
export function createPaymentSummary(parsed: ParsedAlgorandUri): string {
  const parts: string[] = [];

  if (parsed.params.label) {
    parts.push(`to ${parsed.params.label}`);
  } else if (parsed.address) {
    parts.push(
      `to ${parsed.address.slice(0, 8)}...${parsed.address.slice(-8)}`
    );
  }

  if (parsed.params.amount) {
    const assetId = parsed.params.asset ? parseInt(parsed.params.asset) : 0;
    const isNativeToken = assetId === 0;
    const decimals = isNativeToken ? 6 : 0; // VOI/Algos have 6 decimals, other assets default to 0
    const displayAmount = convertAmountToDisplay(
      parsed.params.amount,
      decimals
    );

    if (isNativeToken) {
      const tokenName =
        parsed.scheme === 'voi' || parsed.scheme === 'perawallet'
          ? 'VOI'
          : 'Algos';
      parts.push(`${displayAmount} ${tokenName}`);
    } else {
      parts.push(`${displayAmount} units of asset ${parsed.params.asset}`);
    }
  }

  if (parsed.params.note || parsed.params.xnote) {
    const note = parsed.params.xnote || parsed.params.note;
    parts.push(`with note: "${note}"`);
  }

  return parts.length > 0
    ? `Send ${parts.join(' ')}`
    : 'Process payment request';
}

/**
 * Deflex API Types
 * Types for Deflex swap router on Algorand and Tinyman ASA list
 */

/**
 * Tinyman ASA list token structure
 */
export interface TinymanAsaToken {
  id: string;
  name: string;
  unit_name: string;
  decimals: number;
  url?: string;
  total_amount?: string;
  deleted?: boolean;
  logo?: {
    png?: string;
    svg?: string;
  };
}

/**
 * Tinyman ASA list response (keyed by asset ID)
 */
export interface TinymanAsaList {
  [assetId: string]: TinymanAsaToken;
}

/**
 * Deflex quote route pool
 */
export interface DeflexRoutePool {
  name: string;
  in: { id: number };
  out: { id: number };
}

/**
 * Deflex route segment
 */
export interface DeflexRouteSegment {
  percent: number;
  path: DeflexRoutePool[];
}

/**
 * Deflex individual DEX quote
 */
export interface DeflexDexQuote {
  name: string;
  value: number;
}

/**
 * Deflex API quote response structure
 */
export interface DeflexApiQuoteResponse {
  quote: number;
  profitAmount: number;
  profitASAID: number;
  usdIn: number;
  usdOut: number;
  userPriceImpact: number;
  route: DeflexRouteSegment[];
  quotes: DeflexDexQuote[];
  requiredAppOptIns: number[];
  txnPayload: {
    iv: string;
    data: string;
  };
}

/**
 * Deflex API execute swap response - transaction structure
 */
export interface DeflexTransaction {
  data: string; // Base64 encoded unsigned transaction
  group: string;
  logicSigBlob: string | false;
}

/**
 * Deflex API execute swap transactions response
 */
export interface DeflexExecuteSwapResponse {
  txns: DeflexTransaction[];
}

/**
 * Deflex API error response
 */
export interface DeflexApiErrorResponse {
  error?: string;
  message?: string;
  statusCode?: number;
}

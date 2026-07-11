declare module 'ed2curve' {
  export function convertPublicKey(pk: Uint8Array): Uint8Array | null;
  export function convertSecretKey(sk: Uint8Array): Uint8Array;
  export function convertKeyPair(kp: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }): { publicKey: Uint8Array; secretKey: Uint8Array } | null;
}

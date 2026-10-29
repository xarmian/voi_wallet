/**
 * TASK-425 U2: a pairing proof is signed only with the address's OWN key.
 *
 * SECURITY NOTE: no static/committed secret material; keys are generated
 * in-process.
 */
import algosdk from 'algosdk';
import nacl from 'tweetnacl';

const mockGetPrivateKey = jest.fn<Promise<Uint8Array>, [unknown, unknown]>();
jest.mock('../../secure/keyManager', () => ({
  SecureKeyManager: {
    getPrivateKey: (req: unknown, pin: unknown) => mockGetPrivateKey(req, pin),
  },
}));
jest.mock('../../network', () => ({ NetworkService: {} }));

import { signPairingMessage } from '../index';

const message = new TextEncoder().encode('pairing');

describe('signPairingMessage — key identity (TASK-425)', () => {
  it('signs with the address own key', async () => {
    const own = algosdk.generateAccount();
    mockGetPrivateKey.mockResolvedValueOnce(new Uint8Array(own.sk));
    const sig = await signPairingMessage(own.addr.toString(), message);
    expect(nacl.sign.detached.verify(message, sig, own.addr.publicKey)).toBe(
      true
    );
  });

  it("refuses a stored key that is another address's, and zeroes it", async () => {
    const own = algosdk.generateAccount();
    const other = algosdk.generateAccount();
    const stored = new Uint8Array(other.sk);
    mockGetPrivateKey.mockResolvedValueOnce(stored);
    await expect(
      signPairingMessage(own.addr.toString(), message)
    ).rejects.toThrow(/does not belong/);
    expect(stored.every((b) => b === 0)).toBe(true);
  });
});

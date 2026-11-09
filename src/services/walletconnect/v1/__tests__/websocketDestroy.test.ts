// destroy() clears the connection timeout, so a connect still in flight would
// settle only if the platform fired onopen or onerror. Closing the socket
// settles it, so a client waiting on connect (and every link behind it) is not
// stranded.

import { WalletConnectV1WebSocket } from '../websocket';

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  close = jest.fn();
  send = jest.fn();
}

describe('WalletConnectV1WebSocket.destroy', () => {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  beforeEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = original;
    jest.restoreAllMocks();
  });

  it('settles a connect that is still in flight', async () => {
    const socket = new WalletConnectV1WebSocket('https://bridge.example');
    const connecting = socket.connect();
    socket.destroy();
    await expect(connecting).rejects.toThrow('WebSocket closed');
  });

  it('leaves an established connect untouched', async () => {
    const socket = new WalletConnectV1WebSocket('https://bridge.example');
    const connecting = socket.connect();
    const raw = (socket as unknown as { socket: FakeWebSocket }).socket;
    raw.readyState = 1;
    raw.onopen?.();
    await expect(connecting).resolves.toBeUndefined();
    expect(() => socket.destroy()).not.toThrow();
  });
});

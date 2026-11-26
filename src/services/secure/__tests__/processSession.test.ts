const nativeState = globalThis as typeof globalThis & {
  __voiProcessSessionId: unknown;
};

beforeEach(() => {
  nativeState.__voiProcessSessionId = 'test-process-id';
});

test('returns the native process id and validates missing, non-string, and empty ids', () => {
  const native = jest.requireActual(
    '../../../../modules/voi-process-session'
  ) as typeof import('../../../../modules/voi-process-session');
  const core =
    require('expo-modules-core') as typeof import('expo-modules-core');
  const spy = jest.spyOn(core, 'requireNativeModule');
  try {
    spy.mockReturnValueOnce({ id: 'native-id' } as never);
    expect(native.getNativeProcessSessionId()).toBe('native-id');
    spy.mockImplementationOnce(() => {
      throw new Error('missing native module');
    });
    expect(() => native.getNativeProcessSessionId()).toThrow(
      'missing native module'
    );
    for (const id of [42, '', null]) {
      spy.mockReturnValueOnce({ id } as never);
      expect(() => native.getNativeProcessSessionId()).toThrow();
    }
  } finally {
    spy.mockRestore();
  }
});

test('JS reload keeps the native id; a cold start changes it', () => {
  const first =
    require('../processSession') as typeof import('../processSession');
  expect(first.getProcessSessionId()).toBe('test-process-id');
  jest.resetModules();
  const reloaded =
    require('../processSession') as typeof import('../processSession');
  expect(reloaded.getProcessSessionId()).toBe('test-process-id');
  nativeState.__voiProcessSessionId = 'next-process-id';
  jest.resetModules();
  const coldStart =
    require('../processSession') as typeof import('../processSession');
  expect(coldStart.getProcessSessionId()).toBe('next-process-id');
});

test('the service fails closed for invalid native ids', () => {
  const session =
    require('../processSession') as typeof import('../processSession');
  for (const id of ['', 1, null]) {
    nativeState.__voiProcessSessionId = id;
    expect(() => session.getProcessSessionId()).toThrow();
  }
});

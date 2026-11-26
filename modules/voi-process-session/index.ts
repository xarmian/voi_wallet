import { requireNativeModule } from 'expo-modules-core';

export function getNativeProcessSessionId(): string {
  const id: unknown = requireNativeModule('VoiProcessSession').id;
  if (typeof id !== 'string' || id.length === 0)
    throw new Error('Native process session id unavailable');
  return id;
}

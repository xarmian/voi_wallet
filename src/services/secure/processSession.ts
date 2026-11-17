import { getNativeProcessSessionId } from '../../../modules/voi-process-session';

export function getProcessSessionId(): string {
  const id: unknown = getNativeProcessSessionId();
  if (typeof id !== 'string' || id.length === 0)
    throw new Error('Native process session id unavailable');
  return id;
}

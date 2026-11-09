/**
 * TASK-224 static guard: the raw recovery phrase must never be representable
 * as a SecuritySetup route param (route params are serializable navigation
 * state). The phrase travels through the in-memory secret holder and only its
 * opaque `mnemonicSecretId` is a param.
 *
 * The real guard is the type-level `@ts-expect-error` below, enforced by
 * `npm run typecheck`: if someone re-adds `mnemonic` to the param type, the
 * directive becomes unused and typecheck fails.
 */
import type { RootStackParamList } from '@/navigation/AppNavigator';

type SecuritySetupParams = NonNullable<RootStackParamList['SecuritySetup']>;

// Compile-time: `true` only if SecuritySetup params have no `mnemonic` key.
type HasNoMnemonicKey = 'mnemonic' extends keyof SecuritySetupParams
  ? false
  : true;
const noMnemonicKey: HasNoMnemonicKey = true;

describe('RootStackParamList["SecuritySetup"] (TASK-224)', () => {
  it('has no `mnemonic` key, only an opaque mnemonicSecretId', () => {
    const ok: SecuritySetupParams = {
      mnemonicSecretId: 'opaque-id',
      source: 'create',
    };
    const bad: SecuritySetupParams = {
      // @ts-expect-error — `mnemonic` must not be a SecuritySetup route param.
      mnemonic: 'fake phrase not real',
      source: 'create',
    };
    expect(noMnemonicKey).toBe(true);
    expect(ok).not.toHaveProperty('mnemonic');
    expect(bad).toBeDefined();
  });
});

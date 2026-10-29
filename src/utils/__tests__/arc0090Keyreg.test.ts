/**
 * TASK-439 — keyreg URIs: going online needs both a vote key and a selection
 * key, so a URI that carries only some participation params is rejected as
 * incomplete instead of being read as "go offline" (which silently dropped
 * what the URI did send).
 */

import algosdk from 'algosdk';
import {
  parseArc0090Uri,
  validateKeyregUri,
  Arc0090KeyregUri,
} from '../arc0090Uri';

const ADDRESS = algosdk.generateAccount().addr.toString();
const keyreg = (query: string) => {
  const parsed = parseArc0090Uri(
    `algorand://${ADDRESS}?type=keyreg${query}`
  ) as Arc0090KeyregUri;
  expect(parsed?.type).toBe('keyreg');
  return parsed;
};

it('accepts a plain go-offline URI (no participation params)', () => {
  const uri = keyreg('');

  expect(uri.isOnline).toBe(false);
  expect(validateKeyregUri(uri)).toEqual({ valid: true, errors: [] });
});

it('accepts a complete go-online URI', () => {
  const uri = keyreg('&votekey=AQ&selkey=Ag&votefst=1&votelst=1000&votekd=100');

  expect(uri.isOnline).toBe(true);
  expect(validateKeyregUri(uri).valid).toBe(true);
});

it.each([
  ['a vote key only', '&votekey=AQ&votefst=1&votelst=1000&votekd=100'],
  ['a selection key only', '&selkey=Ag'],
  ['a state proof key only', '&sprfkey=Aw'],
  ['round params only', '&votefst=1&votelst=1000&votekd=100'],
])('rejects %s instead of treating it as go-offline', (_name, query) => {
  const uri = keyreg(query);

  expect(uri.isOnline).toBe(false);
  const result = validateKeyregUri(uri);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain(
    'Participation keys are incomplete: going online needs both a vote key and a selection key'
  );
});

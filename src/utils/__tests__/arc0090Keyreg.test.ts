/**
 * TASK-439 — keyreg URIs: going online needs vote, selection and state proof
 * keys, and a URI that names any participation param without both the vote
 * and selection keys is rejected as incomplete instead of being read as
 * "go offline" (which silently dropped what the URI did send). Presence, not
 * truthiness: an empty or malformed value still counts.
 */

import algosdk from 'algosdk';
import {
  parseArc0090Uri,
  validateKeyregUri,
  Arc0090KeyregUri,
} from '../arc0090Uri';

const ADDRESS = algosdk.generateAccount().addr.toString();
const ONLINE =
  '&votekey=AQ&selkey=Ag&sprfkey=Aw&votefst=1&votelst=1000&votekd=100';
const INCOMPLETE =
  'Participation keys are incomplete: going online needs both a vote key and a selection key';
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
  const uri = keyreg(ONLINE);

  expect(uri.isOnline).toBe(true);
  expect(validateKeyregUri(uri)).toEqual({ valid: true, errors: [] });
});

it('rejects a go-online URI without a state proof key', () => {
  const uri = keyreg(ONLINE.replace('&sprfkey=Aw', ''));

  expect(uri.isOnline).toBe(true);
  const result = validateKeyregUri(uri);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain(
    'State proof key is required for online keyreg'
  );
});

it.each([
  ['a vote key only', '&votekey=AQ&votefst=1&votelst=1000&votekd=100'],
  ['a selection key only', '&selkey=Ag'],
  ['a state proof key only', '&sprfkey=Aw'],
  ['round params only', '&votefst=1&votelst=1000&votekd=100'],
  ['empty vote and selection keys', '&votekey=&selkey='],
  ['an empty state proof key', '&sprfkey='],
  ['a malformed round param the parser drops', '&votefst=abc'],
])('rejects %s instead of treating it as go-offline', (_name, query) => {
  const uri = keyreg(query);

  expect(uri.isOnline).toBe(false);
  const result = validateKeyregUri(uri);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain(INCOMPLETE);
});

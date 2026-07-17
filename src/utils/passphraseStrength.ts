/**
 * Lightweight, dependency-free passphrase strength estimate (TASK-27 PR7).
 *
 * This drives the passphrase entropy METER shown at setup — it is GUIDANCE ONLY.
 * The single HARD gate on a passphrase is the min-length floor enforced by
 * AccountSecureStorage.validateSecret (DOC-137 §7/§12 Q6: length-only, no
 * composition rules). We deliberately avoid zxcvbn (~400 KB+) to keep the RN/Hermes
 * bundle small; this is a rough character-pool × length entropy approximation with
 * mild penalties so a long-but-trivial string ("aaaaaaaaaaaa") does not read as
 * strong. It never rejects — it only scores.
 *
 * SECURITY NOTE: never log the secret. This module returns only an aggregate score.
 */

export type PassphraseStrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PassphraseStrength {
  /** 0 = too short, 1 = weak … 4 = strong. */
  score: PassphraseStrengthScore;
  /** Short human label for the meter. */
  label: 'too short' | 'weak' | 'fair' | 'good' | 'strong';
  /** Rough estimated entropy in bits (for display/debug; not a gate). */
  bits: number;
  /** True once the length floor is met (mirrors the real hard gate). */
  meetsMinLength: boolean;
}

const LABELS: Record<PassphraseStrengthScore, PassphraseStrength['label']> = {
  0: 'too short',
  1: 'weak',
  2: 'fair',
  3: 'good',
  4: 'strong',
};

/** Size of the character pool the secret draws from (used ⇒ contributes). */
function poolSize(secret: string): number {
  let size = 0;
  if (/[a-z]/.test(secret)) size += 26;
  if (/[A-Z]/.test(secret)) size += 26;
  if (/[0-9]/.test(secret)) size += 10;
  // Everything else (symbols, punctuation, whitespace, unicode) — approximate.
  if (/[^a-zA-Z0-9]/.test(secret)) size += 33;
  return size || 1;
}

/**
 * Estimate strength. `minLength` is the same floor validateSecret enforces — a
 * secret shorter than it always scores 0 ('too short'), matching the hard gate.
 */
export function estimatePassphraseStrength(
  secret: string,
  minLength: number
): PassphraseStrength {
  const meetsMinLength = secret.length >= minLength;
  if (!secret || !meetsMinLength) {
    return { score: 0, label: LABELS[0], bits: 0, meetsMinLength };
  }

  const pool = poolSize(secret);
  // Base entropy from an idealized draw: length × log2(pool).
  let bits = secret.length * Math.log2(pool);

  // Uniqueness penalty: repeated characters lower real entropy. Scale by the
  // fraction of distinct characters (e.g. "aaaaaaaaaaaa" → heavy discount).
  const uniqueRatio = new Set(secret).size / secret.length;
  bits *= 0.35 + 0.65 * uniqueRatio;

  // Map bits → a 0–4 score. Thresholds chosen so a ~12-char mixed passphrase
  // (~60+ bits) reads 'good'/'strong' and a min-length all-same string reads 'weak'.
  let score: PassphraseStrengthScore;
  if (bits < 40) score = 1;
  else if (bits < 60) score = 2;
  else if (bits < 80) score = 3;
  else score = 4;

  return {
    score,
    label: LABELS[score],
    bits: Math.round(bits),
    meetsMinLength,
  };
}

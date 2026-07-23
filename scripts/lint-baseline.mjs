#!/usr/bin/env node
/**
 * ESLint baseline / ratchet tool.
 *
 * `npm run lint` is pinned to `--max-warnings <N>` where N is the number in
 * `lint-baseline.json`. This script is what produces that number, and it is the
 * only sanctioned source for the per-rule counts that downstream cleanup tasks
 * are measured against (PLAN-229 DR-2 / DR-9). Never carry those counts by
 * hand — regenerate them.
 *
 * Usage:
 *   node scripts/lint-baseline.mjs                 # report current counts, exit 0
 *   node scripts/lint-baseline.mjs --write         # regenerate lint-baseline.json
 *   node scripts/lint-baseline.mjs --check         # diff current lint run vs. committed baseline
 *   node scripts/lint-baseline.mjs --against=FILE  # CI: ceiling never rose vs. a previous artifact
 *   node scripts/lint-baseline.mjs --top=0         # report: every file, not just the top 20
 *
 * The artifact is written deterministically — repo-relative POSIX paths,
 * alphabetically sorted keys, no timestamps, no machine-specific data — so the
 * git diff of a cleanup PR shows exactly which rules and files moved.
 *
 * The ratchet contract: `--max-warnings` is lowered in the same PR that clears
 * the warnings, the baseline artifact is re-committed in that PR, and the
 * number never goes up. `--check` fails on drift in either direction: an
 * increase breaks the ratchet, and a decrease means a PR cleared warnings
 * without re-committing the artifact.
 *
 * How "never goes up" is actually enforced, rather than merely documented —
 * three cheap facts that compose (see .github/workflows/ci.yml):
 *   1. `npm run lint` proves  actual warnings <= package.json's --max-warnings.
 *   2. `--against` proves     --max-warnings === this branch's artifact total
 *                             (so the pin cannot be inflated past the artifact),
 *      and                    this branch's artifact total <= the base branch's.
 *   3. Therefore              actual warnings <= the base branch's total, and a
 *                             PR cannot raise the ceiling without failing CI.
 * `--against` reads two committed artifacts and never runs ESLint, so it adds
 * no time to CI.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = resolve(REPO_ROOT, 'lint-baseline.json');
const BASELINE_REL = 'lint-baseline.json';
const LINT_TARGET = 'src/';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: node scripts/lint-baseline.mjs [--write | --check | --against=FILE] [--top=N]';

const argv = process.argv.slice(2);
const againstArg = argv.find((a) => a.startsWith('--against='));

const unknown = argv.filter(
  (a) => !['--write', '--check'].includes(a) && !a.startsWith('--top=') && a !== againstArg
);
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}`);
  console.error(USAGE);
  process.exit(2);
}

// The three modes are mutually exclusive: --write mutates the artifact and the
// other two must not, so silently letting one win would let a command meant as
// a read-only check overwrite the committed baseline.
const selected = [
  argv.includes('--write') && 'write',
  argv.includes('--check') && 'check',
  againstArg && 'against',
].filter(Boolean);
if (selected.length > 1) {
  console.error(`Mutually exclusive options: ${selected.map((m) => `--${m}`).join(', ')}`);
  console.error(USAGE);
  process.exit(2);
}
const mode = selected[0] ?? 'report';
const AGAINST_PATH = againstArg ? resolve(againstArg.slice('--against='.length)) : null;

const topArg = argv.find((a) => a.startsWith('--top='));
// --top=0 (or --top=all) prints every file with findings.
const rawTop = topArg ? topArg.slice('--top='.length) : '20';
const TOP_FILES = rawTop === 'all' ? Infinity : Number.parseInt(rawTop, 10) || Infinity;

// ---------------------------------------------------------------------------
// run eslint
// ---------------------------------------------------------------------------

/** Run `eslint src/ -f json` and return the parsed result array. */
function runEslint() {
  // Invoke ESLint's bin through the current node binary: no shell, no npx
  // resolution noise, and the same behaviour on every platform. Deliberately
  // run WITHOUT --max-warnings so the process exit code reflects errors only
  // and we always get a full JSON report to count.
  const eslintBin = resolve(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const result = spawnSync(
    process.execPath,
    [eslintBin, LINT_TARGET, '--format', 'json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }
  );

  if (result.error) {
    console.error(`Failed to run ESLint: ${result.error.message}`);
    process.exit(2);
  }

  const stdout = result.stdout ?? '';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    console.error('ESLint did not emit parseable JSON. Raw output follows:\n');
    console.error(stdout.slice(0, 4000));
    console.error(result.stderr ?? '');
    process.exit(2);
  }

  if (!Array.isArray(parsed)) {
    console.error('Unexpected ESLint JSON payload (expected an array of file results).');
    process.exit(2);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// summarise
// ---------------------------------------------------------------------------

const toPosix = (p) => (sep === '/' ? p : p.split(sep).join('/'));
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
/** Sort for display: most findings first, ties broken alphabetically. */
const byCountThenKey = (a, b) => b[1] - a[1] || byKey(a, b);
const sortedObject = (entries) => Object.fromEntries([...entries].sort(byKey));

/**
 * Reduce a raw ESLint JSON report to the stable shape we commit.
 * Only files with findings are recorded; `filesLinted` keeps the denominator.
 */
function summarise(report) {
  const totals = { errors: 0, warnings: 0, filesLinted: report.length, filesWithFindings: 0 };
  const rules = new Map();
  const files = new Map();

  for (const file of report) {
    totals.errors += file.errorCount ?? 0;
    totals.warnings += file.warningCount ?? 0;

    const messages = file.messages ?? [];
    if (messages.length === 0) continue;
    totals.filesWithFindings += 1;

    const path = toPosix(relative(REPO_ROOT, file.filePath));
    const perFileRules = new Map();

    for (const message of messages) {
      // A fatal parse error has no ruleId; bucket it so it can never hide.
      const ruleId = message.ruleId ?? '(fatal)';
      rules.set(ruleId, (rules.get(ruleId) ?? 0) + 1);
      perFileRules.set(ruleId, (perFileRules.get(ruleId) ?? 0) + 1);
    }

    files.set(path, {
      errors: file.errorCount ?? 0,
      warnings: file.warningCount ?? 0,
      rules: sortedObject(perFileRules.entries()),
    });
  }

  return {
    totals,
    rules: sortedObject(rules.entries()),
    files: sortedObject(files.entries()),
  };
}

/** Serialise the artifact: sorted keys, 2-space indent, trailing newline. */
function serialise(summary) {
  const artifact = {
    $comment: [
      'Committed ESLint baseline for the `npm run lint` ratchet (PLAN-229 DR-2).',
      'Regenerate with `npm run lint:baseline`; verify with `npm run lint:baseline:check`.',
      'The `lint` script\'s --max-warnings MUST equal totals.warnings.',
      'Lower it in the same PR that clears the warnings. It never goes up.',
    ].join(' '),
    ...summary,
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function readBaseline() {
  let raw;
  try {
    raw = readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    console.error(`No baseline at ${BASELINE_REL}. Create it with \`npm run lint:baseline\`.`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${BASELINE_REL} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
}

/**
 * Compare the committed artifact against the base branch's copy. No ESLint run:
 * this is an artifact-to-artifact comparison plus a package.json consistency
 * check, which is what makes it cheap enough to sit in the required CI job.
 */
function compareAgainst(previousPath) {
  // Fail open when there is no previous artifact — a PR branched from a commit
  // that predates the baseline has nothing to ratchet against, and CI writes an
  // empty file when `git show` finds no baseline on the base branch.
  if (!existsSync(previousPath) || readFileSync(previousPath, 'utf8').trim() === '') {
    console.log(`No previous baseline at ${previousPath} — nothing to compare. Skipping.`);
    return 0;
  }

  let previous;
  try {
    previous = JSON.parse(readFileSync(previousPath, 'utf8'));
  } catch (err) {
    console.error(`Previous baseline ${previousPath} is not valid JSON: ${err.message}`);
    return 2;
  }

  const current = readBaseline();
  const previousTotal = previous?.totals?.warnings;
  const currentTotal = current?.totals?.warnings;
  const pin = lintPin();

  if (typeof previousTotal !== 'number' || typeof currentTotal !== 'number') {
    console.error('Both baselines must record totals.warnings as a number.');
    return 2;
  }

  const pinLabel = pin.count === 1 ? pin.value : pin.count === 0 ? 'unset' : `${pin.count}×`;
  console.log('ESLint ratchet — committed baseline vs. base branch');
  console.log(`  base branch:  ${previousTotal} warnings`);
  console.log(`  this branch:  ${currentTotal} warnings (--max-warnings ${pinLabel})`);

  const problems = [];

  if (currentTotal > previousTotal) {
    problems.push(
      `The baseline rose from ${previousTotal} to ${currentTotal}. The ratchet only turns ` +
        'one way — fix the new warnings instead of raising the ceiling.'
    );
  }

  // Without this the pin could be inflated while the artifact stayed put.
  const pinIssue = pinProblem(pin, currentTotal);
  if (pinIssue) problems.push(pinIssue);

  // Per-rule movement is reported but never enforced: a legitimate refactor can
  // trade one rule for another (e.g. adding memoization moves warnings into
  // react-hooks/preserve-manual-memoization), so the total is the gate.
  const ruleNames = [
    ...new Set([...Object.keys(previous.rules ?? {}), ...Object.keys(current.rules ?? {})]),
  ].sort();
  const ruleDrift = ruleNames
    .map((rule) => [rule, previous.rules?.[rule] ?? 0, current.rules?.[rule] ?? 0])
    .filter(([, before, after]) => before !== after);

  if (ruleDrift.length > 0) {
    console.log('\nPer-rule change (informational — only the total is gated):');
    for (const [rule, before, after] of ruleDrift) {
      console.log(
        `  ${String(before).padStart(5)} → ${String(after).padEnd(5)} (${delta(before, after)})  ${rule}`
      );
    }
  }

  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    return 1;
  }

  console.log(
    currentTotal < previousTotal
      ? `\nOK: ceiling lowered by ${previousTotal - currentTotal}.`
      : '\nOK: ceiling unchanged.'
  );
  return 0;
}

/**
 * The --max-warnings pin in the `lint` npm script.
 *   { count: 0 }            → not pinned
 *   { count: 1, value: N }  → pinned to N
 *   { count: >1 }           → pinned more than once (ambiguous)
 *
 * `count` matters as much as `value`: ESLint honours the LAST occurrence of a
 * repeated flag, so `--max-warnings 682 … --max-warnings 1000` would satisfy a
 * naive "first match === total" check while ESLint quietly admitted new
 * warnings. Any count other than exactly one is rejected by the callers.
 */
function lintPin() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const matches = [...(pkg.scripts?.lint ?? '').matchAll(/--max-warnings(?:[= ])(\d+)/g)];
    if (matches.length === 0) return { count: 0, value: null };
    // Report the last value (what ESLint would use) for messaging.
    return { count: matches.length, value: Number.parseInt(matches.at(-1)[1], 10) };
  } catch {
    return { count: 0, value: null };
  }
}

/**
 * Validate the pin against an expected total, returning a problem string or
 * null. Shared by --check, --against and --write so the rule is defined once.
 */
function pinProblem(pin, expectedTotal) {
  if (pin.count === 0) {
    return 'The `lint` script has no --max-warnings, so the CI lint gate is decorative.';
  }
  if (pin.count > 1) {
    return (
      `The \`lint\` script has ${pin.count} --max-warnings flags. ESLint honours the last, ` +
      'so a stale earlier one would hide new warnings — keep exactly one.'
    );
  }
  if (pin.value !== expectedTotal) {
    return (
      `package.json pins --max-warnings ${pin.value} but the baseline records ${expectedTotal}. ` +
      'They must match — regenerate with `npm run lint:baseline`.'
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function printReport(summary) {
  const { totals, rules, files } = summary;

  console.log(`ESLint baseline — \`eslint ${LINT_TARGET}\``);
  console.log(
    `  ${totals.warnings} warnings · ${totals.errors} errors · ` +
      `${totals.filesWithFindings}/${totals.filesLinted} files with findings\n`
  );

  const ruleRows = Object.entries(rules).sort(byCountThenKey);
  console.log(`Per rule (${ruleRows.length}):`);
  for (const [rule, count] of ruleRows) {
    console.log(`  ${String(count).padStart(5)}  ${rule}`);
  }

  const fileRows = Object.entries(files)
    .map(([path, entry]) => [path, entry.errors + entry.warnings])
    .sort(byCountThenKey);
  const shown = fileRows.slice(0, TOP_FILES);
  const heading =
    shown.length < fileRows.length
      ? `\nPer file (top ${shown.length} of ${fileRows.length} — use --top=all for every file):`
      : `\nPer file (${fileRows.length}):`;
  console.log(heading);
  for (const [path, count] of shown) {
    console.log(`  ${String(count).padStart(5)}  ${path}`);
  }
}

/** Render a +N / -N delta, or null when nothing changed. */
function delta(before, after) {
  const diff = after - before;
  return diff === 0 ? null : `${diff > 0 ? '+' : ''}${diff}`;
}

function printCheck(summary, baseline) {
  const base = { rules: {}, files: {}, totals: {}, ...baseline };
  const problems = [];

  const totalDelta = delta(base.totals.warnings ?? 0, summary.totals.warnings);
  const errorDelta = delta(base.totals.errors ?? 0, summary.totals.errors);

  console.log(`ESLint baseline check — \`eslint ${LINT_TARGET}\``);
  console.log(
    `  warnings: ${base.totals.warnings ?? '?'} → ${summary.totals.warnings}` +
      (totalDelta ? ` (${totalDelta})` : ' (unchanged)')
  );
  console.log(
    `  errors:   ${base.totals.errors ?? '?'} → ${summary.totals.errors}` +
      (errorDelta ? ` (${errorDelta})` : ' (unchanged)')
  );

  // Per-rule drift.
  const ruleNames = [...new Set([...Object.keys(base.rules), ...Object.keys(summary.rules)])].sort();
  const ruleDrift = ruleNames
    .map((rule) => [rule, base.rules[rule] ?? 0, summary.rules[rule] ?? 0])
    .filter(([, before, after]) => before !== after);

  if (ruleDrift.length > 0) {
    console.log('\nPer-rule drift:');
    for (const [rule, before, after] of ruleDrift) {
      console.log(`  ${String(before).padStart(5)} → ${String(after).padEnd(5)} (${delta(before, after)})  ${rule}`);
    }
  }

  // Per-file drift.
  const filePaths = [...new Set([...Object.keys(base.files), ...Object.keys(summary.files)])].sort();
  const fileDrift = filePaths
    .map((path) => {
      const before = base.files[path];
      const after = summary.files[path];
      const beforeCount = before ? before.errors + before.warnings : 0;
      const afterCount = after ? after.errors + after.warnings : 0;
      return [path, beforeCount, afterCount];
    })
    .filter(([, before, after]) => before !== after);

  if (fileDrift.length > 0) {
    console.log('\nPer-file drift:');
    for (const [path, before, after] of fileDrift) {
      console.log(`  ${String(before).padStart(5)} → ${String(after).padEnd(5)} (${delta(before, after)})  ${path}`);
    }
  }

  if (summary.totals.warnings > (base.totals.warnings ?? 0)) {
    problems.push(
      'Warning count went UP. The ratchet only turns one way — fix the new warnings ' +
        'rather than raising the baseline.'
    );
  } else if (summary.totals.warnings < (base.totals.warnings ?? 0)) {
    problems.push(
      `Warning count went DOWN but ${BASELINE_REL} was not regenerated. Run ` +
        '`npm run lint:baseline` and lower --max-warnings in the same commit.'
    );
  } else if (ruleDrift.length > 0 || fileDrift.length > 0) {
    problems.push(
      `Totals match but the per-rule/per-file breakdown moved. Run \`npm run lint:baseline\` ` +
        `and commit the updated ${BASELINE_REL}.`
    );
  }

  if (summary.totals.errors > 0) {
    problems.push('ESLint reported errors. Errors are never baselined.');
  }

  const pin = lintPin();
  const pinIssue = pinProblem(pin, summary.totals.warnings);
  if (pinIssue) problems.push(pinIssue);

  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    return 1;
  }

  console.log(`\nOK: matches ${BASELINE_REL}, and package.json pins --max-warnings ${pin.value}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// --against compares two committed artifacts, so it must not run ESLint.
if (mode === 'against') {
  process.exit(compareAgainst(AGAINST_PATH));
}

const summary = summarise(runEslint());

if (mode === 'write') {
  writeFileSync(BASELINE_PATH, serialise(summary), 'utf8');
  printReport(summary);
  console.log(`\nWrote ${BASELINE_REL}.`);
  const pin = lintPin();
  if (pin.count !== 1 || pin.value !== summary.totals.warnings) {
    const shown = pin.count === 0 ? '(none)' : pin.count > 1 ? `${pin.count} flags` : pin.value;
    console.log(
      `NOTE: package.json pins --max-warnings ${shown}; ` +
        `set it to exactly ${summary.totals.warnings} in this same commit.`
    );
  }
  process.exit(0);
}

if (mode === 'check') {
  process.exit(printCheck(summary, readBaseline()));
}

printReport(summary);

#!/usr/bin/env node
/**
 * Reaps the worktrees and branch refs that agent tooling leaves behind.
 *
 * Claude Code's worktree isolation creates a worktree under .claude/worktrees/
 * plus a `worktree-<id>` branch ref, and never cleans either one up. They
 * accumulate: a single sweep in Aug 2026 found 14 stale worktrees (2.8 GB) and
 * 40 orphaned `worktree-*` refs, none of which held unmerged work.
 *
 * This repo squash-merges, so `git merge-base --is-ancestor <branch> main`
 * reports NO for branches that are fully merged. Ancestry alone would refuse to
 * clean anything. We check three ways and accept any one of them:
 *
 *   1. the branch tip is a literal ancestor of main
 *   2. the tip equals (or is an ancestor of) a MERGED PR's headRefOid
 *   3. every file the branch added is already present in main
 *
 * Refuses to touch main, the current branch, or anything with an OPEN PR.
 * Dry-run unless --apply is passed.
 *
 * Usage:
 *   node scripts/worktree-janitor.mjs                # report only
 *   node scripts/worktree-janitor.mjs --apply        # actually delete
 *   node scripts/worktree-janitor.mjs --all-merged   # widen past worktree-* refs
 */

import { execFileSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const ALL_MERGED = args.has('--all-merged');
const BASE = 'origin/main';
const WORKTREE_REF = /^worktree-/;

if (args.has('--help') || args.has('-h')) {
  console.log(
    [
      'worktree-janitor — remove merged agent worktrees and their branch refs',
      '',
      '  --apply        perform deletions (default: dry run)',
      '  --all-merged   also consider non-worktree-* branches',
      '  --help         this message',
    ].join('\n')
  );
  process.exit(0);
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const gitOk = (...a) => {
  try {
    execFileSync('git', a, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** PR metadata by branch name. Empty when gh is unavailable — we degrade to ancestry only. */
function prsFor(branch) {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--head',
        branch,
        '--limit',
        '10',
        '--json',
        'number,state,headRefOid',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return JSON.parse(out);
  } catch {
    return [];
  }
}

/**
 * Why this branch is safe to delete, or null to keep it.
 * An OPEN PR is an absolute veto regardless of what the other checks say.
 */
function mergedReason(branch, sha) {
  const prs = prsFor(branch);
  if (prs.some((p) => p.state === 'OPEN')) return null;

  if (gitOk('merge-base', '--is-ancestor', sha, BASE))
    return 'ancestor-of-main';

  for (const pr of prs) {
    if (pr.state !== 'MERGED') continue;
    if (pr.headRefOid === sha) return `PR#${pr.number} head`;
    if (gitOk('merge-base', '--is-ancestor', sha, pr.headRefOid))
      return `PR#${pr.number} ancestor`;
  }

  // Squash-merged and the PR lookup missed it (agent refs carry a different name
  // than the PR's head branch). Fall back to content: nothing new means nothing lost.
  const mergeBase = git('merge-base', BASE, sha);
  const added = git('diff', '--diff-filter=A', '--name-only', mergeBase, sha)
    .split('\n')
    .filter((f) => f && !f.startsWith('node_modules'));
  if (
    added.length &&
    added.every((f) => gitOk('cat-file', '-e', `${BASE}:${f}`))
  ) {
    return 'content-in-main';
  }
  return null;
}

/** node_modules is gitignored; its presence is not real work. Anything else is. */
function realChanges(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((l) => l.trim() && !l.includes('node_modules'));
  } catch {
    return [];
  }
}

git('fetch', 'origin', '--quiet');
const currentBranch = git('rev-parse', '--abbrev-ref', 'HEAD');
const mainRoot = git('rev-parse', '--show-toplevel');

// ---- worktrees ----------------------------------------------------------
const worktrees = git('worktree', 'list', '--porcelain')
  .split('\n\n')
  .map((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    return path && path !== mainRoot ? { path, branch } : null;
  })
  .filter(Boolean);

const wtRemove = [];
for (const wt of worktrees) {
  const dirty = realChanges(wt.path);
  if (dirty.length) {
    console.log(
      `KEEP     ${wt.path}  — uncommitted work:\n         ${dirty.join('\n         ')}`
    );
    continue;
  }
  const sha = git('-C', wt.path, 'rev-parse', 'HEAD');
  const why = wt.branch ? mergedReason(wt.branch, sha) : 'detached';
  if (why) wtRemove.push({ ...wt, why });
  else console.log(`KEEP     ${wt.path}  — branch ${wt.branch} is not merged`);
}

for (const wt of wtRemove) {
  console.log(`${APPLY ? 'REMOVE  ' : 'would rm'} ${wt.path}  [${wt.why}]`);
  if (APPLY) git('worktree', 'remove', '--force', wt.path);
}
if (APPLY && wtRemove.length) git('worktree', 'prune');

// ---- branches -----------------------------------------------------------
// A branch still checked out in a surviving worktree cannot be deleted — git
// refuses, and we kept that worktree on purpose (dirty or unmerged). Only
// branches whose worktree we just removed, or that never had one, are eligible.
const removedPaths = new Set(wtRemove.map((w) => w.path));
const stillAttached = new Set(
  worktrees
    .filter((w) => w.branch && !removedPaths.has(w.path))
    .map((w) => w.branch)
);

const branches = git(
  'for-each-ref',
  '--format=%(refname:short) %(objectname)',
  'refs/heads/'
)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [name, sha] = l.split(' ');
    return { name, sha };
  })
  .filter((b) => b.name !== 'main' && b.name !== currentBranch)
  .filter((b) => !stillAttached.has(b.name))
  .filter((b) => ALL_MERGED || WORKTREE_REF.test(b.name));

let deleted = 0;
let kept = 0;
for (const b of branches) {
  const why = mergedReason(b.name, b.sha);
  if (!why) {
    console.log(`KEEP     ${b.name}  — unmerged or has an open PR`);
    kept += 1;
    continue;
  }
  console.log(
    `${APPLY ? 'DELETE  ' : 'would rm'} ${b.name}  ${b.sha.slice(0, 9)}  [${why}]`
  );
  if (APPLY) git('branch', '-D', b.name);
  deleted += 1;
}

console.log(
  `\n${APPLY ? 'removed' : 'would remove'}: ${wtRemove.length} worktree(s), ${deleted} branch(es); kept ${kept}`
);
if (!APPLY && (wtRemove.length || deleted)) {
  console.log('Dry run — re-run with --apply to delete.');
}

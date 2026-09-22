// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';

export const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RC_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/;

/**
 * @typedef {{ version: string, sha: string, sourceSha: string, timestamp: number }} ReleaseSource
 * @typedef {{ head: string, stable: ReleaseSource[], candidates: string[] }} ReleaseHistory
 */

/** @param {string} message */
export function readSourceCommit(message) {
  const paragraphs = message.trimEnd().split(/\r?\n\r?\n/);
  const matches = message.split(/\r?\n/).filter((line) => /^Source-Commit:/i.test(line));
  if (
    paragraphs.length < 2 ||
    matches.length !== 1 ||
    !paragraphs.at(-1).split(/\r?\n/).includes(matches[0]) ||
    !/^Source-Commit: [0-9a-f]{40}$/i.test(matches[0])
  ) {
    throw new Error('Expected exactly one full Source-Commit SHA in the commit footer');
  }
  return matches[0].slice('Source-Commit: '.length).toLowerCase();
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync(
    'git',
    [
      '--no-pager',
      ...args
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe'
      ]
    }
  ).trim();
}

/** @param {string} cwd @param {string} [ref] */
export function sourceHead(cwd, ref = 'HEAD') {
  return git(cwd, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`
  ]);
}

/** @param {string} cwd @param {string} start @param {string} end */
export function assertSourceAncestor(cwd, start, end) {
  const result = spawnSync(
    'git',
    [
      '--no-pager',
      'merge-base',
      '--is-ancestor',
      start,
      end
    ],
    {
      cwd,
      encoding: 'utf8'
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Source-Commit ${start} must exist and be an ancestor of source ${end}`);
  }
}

/** @param {string | undefined} start @param {string} end */
export function sourceRange(start, end) {
  return start ? `${start}..${end}` : end;
}

/** @param {string} cwd @param {string} tag @param {string} head @returns {ReleaseSource} */
export function readReleaseSource(cwd, tag, head) {
  if (!STABLE_TAG.test(tag) && !RC_TAG.test(tag)) throw new Error(`Unsupported release tag: ${tag}`);
  const sha = sourceHead(cwd, `refs/tags/${tag}`);
  const sourceSha = readSourceCommit(
    git(cwd, [
      'show',
      '--no-patch',
      '--format=%B',
      sha,
      '--'
    ])
  );
  assertSourceAncestor(cwd, sourceSha, head);
  return {
    version: tag,
    sha,
    sourceSha,
    timestamp: Number(
      git(cwd, [
        'show',
        '--no-patch',
        '--format=%ct',
        sha,
        '--'
      ])
    )
  };
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
  const a = left.slice(1).split('.').map(BigInt);
  const b = right.slice(1).split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Published versions supply labels; their Source-Commit trailers supply the
 * source-history boundaries. Drafts and unpublished tags are not release baselines.
 * @param {Object} params
 * @param {Array<{ tag_name: string, draft: boolean, prerelease: boolean }>} params.releases
 * @param {string} [params.cwd]
 * @returns {ReleaseHistory}
 */
export function resolveHistory({ releases, cwd = process.cwd() }) {
  const head = sourceHead(cwd);
  const published = releases.filter((release) => !release.draft);
  const stableTags = published.filter((release) => !release.prerelease && STABLE_TAG.test(release.tag_name));
  const stable = [...new Set(stableTags.map((release) => release.tag_name))]
    .sort(compareVersions)
    .map((tag) => readReleaseSource(cwd, tag, head));
  for (let index = 1; index < stable.length; index++) {
    assertSourceAncestor(cwd, stable[index - 1].sourceSha, stable[index].sourceSha);
  }
  return {
    head,
    stable,
    candidates: published
      .filter((release) => release.prerelease && RC_TAG.test(release.tag_name))
      .map((release) => release.tag_name)
  };
}

/** @param {ReleaseHistory} history @param {string} version @param {string} cwd */
export function latestCandidate(history, version, cwd) {
  const tags = history.candidates.filter((tag) => tag.startsWith(`${version}-rc.`));
  tags.sort((a, b) => {
    const left = BigInt(a.split('-rc.')[1]);
    const right = BigInt(b.split('-rc.')[1]);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
  const tag = tags.at(-1);
  if (!tag) return null;
  const candidate = readReleaseSource(cwd, tag, history.head);
  const stable = history.stable.at(-1);
  if (stable) assertSourceAncestor(cwd, stable.sourceSha, candidate.sourceSha);
  return candidate;
}

/**
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context
 * @param {import('@actions/github').GitHub} params.github
 * @param {import('@actions/core')} params.core
 */
export default async function main({ context, github, core }) {
  const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const history = resolveHistory({ releases });
  const range = sourceRange(history.stable.at(-1)?.sourceSha, history.head);
  core.info(`Source release range: ${range}`);
  core.setOutput('history', JSON.stringify(history));
  core.setOutput('range', range);
}

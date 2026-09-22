// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { latestCandidate, sourceHead, sourceRange, STABLE_TAG } from './release-history.mjs';

/**
 * git-cliff requires collection fields even on the synthetic previous release.
 * Version labels and source IDs are independent of orphan artifact tag discovery.
 * @param {Array<Record<string, any>>} context
 * @param {import('./release-history.mjs').ReleaseSource | undefined} previous
 * @param {string} head
 * @param {string | null} [version]
 * @param {number} [timestamp]
 */
export function releaseContext(context, previous, head, version = null, timestamp = 0) {
  if (!Array.isArray(context) || context.length > 1 || (context[0] && !Array.isArray(context[0].commits))) {
    throw new Error('Expected one tag-free git-cliff source context');
  }
  const empty = {
    commits: [],
    submodule_commits: {},
    github: { contributors: [] },
    gitlab: { contributors: [] },
    gitea: { contributors: [] },
    bitbucket: { contributors: [] },
    azure_devops: { contributors: [] }
  };
  return {
    ...empty,
    ...context[0],
    version,
    commit_id: head,
    timestamp,
    previous:
      previous ?
        {
          ...empty,
          version: previous.version,
          commit_id: previous.sourceSha,
          timestamp: previous.timestamp,
          previous: null
        }
      : null
  };
}

/**
 * @param {Object} params
 * @param {import('./release-history.mjs').ReleaseHistory} params.history
 * @param {Array<Record<string, any>>} params.context
 * @param {'rc' | 'stable'} params.mode
 * @param {(args: string[], input?: string) => string} params.cliff
 * @param {string} [params.cwd]
 */
export function buildReleaseNotes({ history, context, mode, cliff, cwd = process.cwd() }) {
  if (sourceHead(cwd) !== history.head) throw new Error('Source HEAD changed after resolving release history');
  const stable = history.stable.at(-1);
  const current = releaseContext(context, stable, history.head);
  if (current.commits.length === 0) return { skip: true, version: stable?.version || '' };

  const [bumped] = JSON.parse(
    cliff(
      [
        '--from-context',
        '-',
        '--bump',
        '--context'
      ],
      JSON.stringify([current])
    )
  );
  const version = bumped?.version;
  if (!STABLE_TAG.test(version || '')) throw new Error('git-cliff did not return a stable release version');
  if (version === stable?.version) return { skip: true, version };

  const candidate = latestCandidate(history, version, cwd);
  const next = candidate ? BigInt(candidate.version.split('-rc.')[1]) + 1n : 1n;
  const rcTag = `${version}-rc.${next}`;
  const render = (releases, args = []) =>
    cliff(
      [
        '--from-context',
        '-',
        ...args
      ],
      JSON.stringify(releases)
    );
  const collect = (start, end) =>
    JSON.parse(
      cliff([
        '--tag-pattern',
        '^$',
        '--context',
        sourceRange(start, end)
      ])
    );

  if (mode === 'rc') {
    const rc =
      candidate ?
        releaseContext(collect(candidate.sourceSha, history.head), candidate, history.head, rcTag, bumped.timestamp)
      : { ...bumped, version: rcTag };
    if (rc.commits.length === 0) return { skip: true, version };
    return {
      skip: false,
      version,
      rcTag,
      content: render(
        [rc],
        [
          '--strip',
          'header'
        ]
      )
    };
  }
  if (mode !== 'stable') throw new Error(`Unsupported release notes mode: ${mode}`);
  if (!candidate) throw new Error(`No published release candidate for ${version}; publish the draft RC first`);
  const afterCandidate = releaseContext(collect(candidate.sourceSha, history.head), candidate, history.head);
  if (afterCandidate.commits.length > 0) {
    throw new Error(
      `Published RC ${candidate.version} is missing releasable source changes; publish the current draft first`
    );
  }
  const released = releaseContext(
    collect(stable?.sourceSha, candidate.sourceSha),
    stable,
    candidate.sourceSha,
    version,
    bumped.timestamp
  );

  const previousReleases = history.stable.map((release, index) =>
    releaseContext(
      collect(history.stable[index - 1]?.sourceSha, release.sourceSha),
      history.stable[index - 1],
      release.sourceSha,
      release.version,
      release.timestamp
    )
  );
  return {
    skip: false,
    version,
    candidate,
    content: render(
      [released],
      [
        '--strip',
        'header'
      ]
    ),
    changelog: render([
      released,
      ...previousReleases.reverse()
    ])
  };
}

/**
 * INPUT_MODE: rc or stable; INPUT_HISTORY: verified release-history output;
 * INPUT_CLI_PATH: the pinned git-cliff binary installed by the workflow.
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context
 * @param {import('@actions/core')} params.core
 */
export default async function main({ context, core }) {
  const cwd = process.cwd();
  const binary = core.getInput('CLI_PATH', { required: true });
  const mode = core.getInput('MODE', { required: true });
  if (mode !== 'rc' && mode !== 'stable') throw new Error(`Unsupported release notes mode: ${mode}`);
  const history = JSON.parse(core.getInput('HISTORY', { required: true }));
  const env = { ...process.env };
  delete env.GIT_CLIFF_OUTPUT;
  delete env.GIT_CLIFF_PREPEND;
  const cliff = (args, input) =>
    execFileSync(
      binary,
      [
        '--config',
        path.join(cwd, '.github', 'cliff.toml'),
        '--github-repo',
        `${context.repo.owner}/${context.repo.repo}`,
        ...args
      ],
      { cwd, env, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
  const parsed = JSON.parse(
    cliff([
      '--tag-pattern',
      '^$',
      '--context',
      sourceRange(history.stable.at(-1)?.sourceSha, history.head)
    ])
  );
  const result = buildReleaseNotes({ history, context: parsed, mode, cliff, cwd });
  if (result.skip && mode === 'stable') throw new Error('Nothing to release: no new releasable source commits');
  core.setOutput('skip', String(result.skip));
  core.setOutput('version', result.version);
  if (result.skip) {
    core.info('No new releasable source commits; skipping prerelease.');
    return;
  }
  core.setOutput('content', result.content);
  core.setOutput('rc_tag', result.rcTag || '');
  if (result.candidate) {
    core.setOutput('candidate_tag', result.candidate.version);
    core.setOutput('candidate_sha', result.candidate.sha);
    fs.writeFileSync('CHANGELOG.md', result.changelog);
  }
}

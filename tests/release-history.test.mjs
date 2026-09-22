import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';

import { latestCandidate, readSourceCommit, resolveHistory, sourceRange } from '../.github/scripts/release-history.mjs';
import { buildReleaseNotes, releaseContext } from '../.github/scripts/release-notes.mjs';

const fixtures = new Set();
const configPath = path.resolve('.github', 'cliff.toml');

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-release-history-'));
  fixtures.add(cwd);
  const git = (args, input) =>
    execFileSync(
      'git',
      [
        '--no-pager',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        '-c',
        `core.hooksPath=${path.join(cwd, 'empty-hooks')}`,
        ...args
      ],
      { cwd, input, encoding: 'utf8', stdio: [
          'pipe',
          'pipe',
          'pipe'
        ] }
    ).trim();
  git([
    'init',
    '--initial-branch=main'
  ]);
  git([
    'config',
    'user.name',
    'Release Test'
  ]);
  git([
    'config',
    'user.email',
    'test@example.invalid'
  ]);
  const releases = [];
  let revision = 0;
  return {
    cwd,
    git,
    releases,
    commit(message) {
      fs.writeFileSync(path.join(cwd, 'source.txt'), `revision ${++revision}\n`);
      git([
        'add',
        '--',
        'source.txt'
      ]);
      git([
        'commit',
        '-m',
        message
      ]);
      return git([
        'rev-parse',
        'HEAD'
      ]);
    },
    artifact(tag, sourceSha, { published = true, message, annotated = false } = {}) {
      const blob = git(
        [
          'hash-object',
          '-w',
          '--stdin'
        ],
        'artifact\n'
      );
      const tree = git(['mktree'], `100644 blob ${blob}\tREADME.md\n`);
      const sha = git([
        'commit-tree',
        tree,
        '-m',
        message ?? `chore(release): ${tag}\n\nSource-Commit: ${sourceSha}\n`
      ]);
      git(
        annotated ? [
            'tag',
            '-a',
            tag,
            sha,
            '-m',
            tag
          ] : [
            'tag',
            tag,
            sha
          ]
      );
      if (published) releases.push({ tag_name: tag, draft: false, prerelease: tag.includes('-rc.') });
      return sha;
    },
    history() {
      return resolveHistory({ releases, cwd });
    }
  };
}

afterEach(() => {
  for (const cwd of fixtures) fs.rmSync(cwd, { recursive: true, force: true });
  fixtures.clear();
});

function recorder(repo, version = 'v2.0.1') {
  const calls = [];
  const cliff = (args, input) => {
    calls.push({ args, input });
    if (input !== undefined) {
      const context = JSON.parse(input);
      return JSON.stringify(args.includes('--bump') ? [{ ...context[0], version, timestamp: 1_800_000_000 }] : context);
    }
    expect(args.slice(0, 3)).toEqual([
      '--tag-pattern',
      '^$',
      '--context'
    ]);
    const output = repo.git([
      'log',
      '--reverse',
      '--format=%H%x00%s',
      args.at(-1),
      '--'
    ]);
    const commits = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [
          id,
          message
        ] = line.split('\0');
        return { id, message };
      })
      .filter((commit) => !/^chore\((release|deps)/.test(commit.message));
    return JSON.stringify([{ commits }]);
  };
  return { cliff, calls };
}

function calculate(repo, mode, cliff) {
  const history = repo.history();
  const range = sourceRange(history.stable.at(-1)?.sourceSha, history.head);
  const context = JSON.parse(
    cliff([
      '--tag-pattern',
      '^$',
      '--context',
      range
    ])
  );
  return buildReleaseNotes({ history, context, mode, cliff, cwd: repo.cwd });
}

describe('source history behind orphan release tags', () => {
  it('resolves an annotated artifact tag to its source, not its unrelated artifact history', () => {
    const repo = repository();
    const released = repo.commit('feat!: original breaking change');
    const artifact = repo.artifact('v2.0.0', released, { annotated: true });
    const head = repo.commit('fix: current repair');

    expect(
      repo.git([
        'rev-list',
        '--count',
        `${artifact}..HEAD`
      ])
    ).toBe('2');
    expect(repo.history().stable[0]).toMatchObject({ version: 'v2.0.0', sha: artifact, sourceSha: released });
    expect(sourceRange(released, head)).toBe(`${released}..${head}`);
    const { cliff, calls } = recorder(repo);
    const result = calculate(repo, 'rc', cliff);
    const bump = JSON.parse(calls.find((call) => call.args.includes('--bump')).input)[0];
    expect(bump.previous.version).toBe('v2.0.0');
    expect(bump.previous.commit_id).toBe(released);
    expect(bump.commits.map((commit) => commit.message)).toEqual(['fix: current repair']);
    expect(result.rcTag).toBe('v2.0.1-rc.1');
  });

  it('uses all source history with no version baseline for the initial release', () => {
    const repo = repository();
    const head = repo.commit('feat!: first implementation');
    const { cliff, calls } = recorder(repo, 'v2.0.0');

    expect(calculate(repo, 'rc', cliff).rcTag).toBe('v2.0.0-rc.1');
    expect(calls[0].args.at(-1)).toBe(head);
    expect(JSON.parse(calls.find((call) => call.args.includes('--bump')).input)[0].previous).toBeNull();
  });

  it('numbers RCs numerically and collects only changes since the latest published RC source', () => {
    const repo = repository();
    const stable = repo.commit('feat: stable feature');
    repo.artifact('v2.0.0', stable);
    const first = repo.commit('fix: earlier patch');
    repo.artifact('v2.0.1-rc.2', first);
    const latest = repo.commit('fix: published patch');
    repo.artifact('v2.0.1-rc.10', latest);
    const head = repo.commit('fix: incremental patch');
    repo.releases.push({ tag_name: 'v2.0.1-rc.99', draft: true, prerelease: true });
    const { cliff, calls } = recorder(repo);

    const result = calculate(repo, 'rc', cliff);

    expect(result.rcTag).toBe('v2.0.1-rc.11');
    expect(calls.some((call) => call.args.at(-1) === `${latest}..${head}`)).toBe(true);
    expect(JSON.parse(result.content)[0].commits.map((commit) => commit.message)).toEqual(['fix: incremental patch']);
  });

  it('does not reissue the same RC or bump on source commits filtered out of release notes', () => {
    const repo = repository();
    const first = repo.commit('feat: initial feature');
    repo.artifact('v2.0.0-rc.1', first);
    expect(calculate(repo, 'rc', recorder(repo, 'v2.0.0').cliff).skip).toBe(true);
    repo.artifact('v2.0.0', first);
    repo.commit('chore(release): v2.0.0');
    repo.commit('chore(deps): ignored update');
    const { cliff, calls } = recorder(repo);

    expect(calculate(repo, 'rc', cliff).skip).toBe(true);
    expect(calls.some((call) => call.args.includes('--bump'))).toBe(false);
  });

  it('ignores drafts and an unpublished stable tag instead of treating them as shipped baselines', () => {
    const repo = repository();
    const first = repo.commit('feat: first');
    repo.artifact('v9.0.0', first, { published: false, message: 'not a released source record' });
    repo.releases.push({ tag_name: 'v9.0.0', draft: true, prerelease: false });

    expect(repo.history().stable).toEqual([]);
    expect(calculate(repo, 'rc', recorder(repo, 'v2.0.0').cliff).rcTag).toBe('v2.0.0-rc.1');
  });

  it('reconstructs each stable changelog section from its own source interval', () => {
    const repo = repository();
    const first = repo.commit('feat: first');
    repo.artifact('v2.0.0', first);
    const second = repo.commit('feat: second');
    repo.artifact('v2.1.0', second);
    const head = repo.commit('fix: current');
    repo.artifact('v2.1.1-rc.1', head);

    const result = calculate(repo, 'stable', recorder(repo, 'v2.1.1').cliff);
    const sections = JSON.parse(result.changelog);
    expect(sections.map((release) => release.version)).toEqual([
      'v2.1.1',
      'v2.1.0',
      'v2.0.0'
    ]);
    expect(sections.map((release) => release.commits.map((commit) => commit.message))).toEqual([
      ['fix: current'],
      ['feat: second'],
      ['feat: first']
    ]);
    expect(sections[0].previous.commit_id).toBe(second);
    expect(result.candidate.sourceSha).toBe(head);
  });

  it('requires prepared notes and the published RC to describe the same source', () => {
    const repo = repository();
    const first = repo.commit('feat: first');
    const cliff = recorder(repo, 'v2.0.0').cliff;
    expect(() => calculate(repo, 'stable', cliff)).toThrow('No published release candidate');
    repo.artifact('v2.0.0-rc.1', first);
    repo.commit('fix: not published yet');
    expect(() => calculate(repo, 'stable', cliff)).toThrow('missing releasable source changes');
  });

  it('can prepare a published RC after ignored commits without inventing a new artifact source boundary', () => {
    const repo = repository();
    const source = repo.commit('feat: first');
    repo.artifact('v2.0.0-rc.1', source);
    repo.commit('chore(deps): ignored update');
    const cliff = recorder(repo, 'v2.0.0').cliff;

    expect(calculate(repo, 'rc', cliff).skip).toBe(true);
    const stable = calculate(repo, 'stable', cliff);
    expect(stable.candidate.sourceSha).toBe(source);
    expect(JSON.parse(stable.content)[0].commit_id).toBe(source);
    expect(JSON.parse(stable.content)[0].commits.map((commit) => commit.message)).toEqual(['feat: first']);
  });

  it.each([
    'chore(release): missing trailer',
    'chore(release): invalid\n\nSource-Commit: short',
    `chore(release): duplicate\n\nSource-Commit: ${'a'.repeat(40)}\nsource-commit: ${'b'.repeat(40)}`,
    `chore(release): misplaced\n\nSource-Commit: ${'a'.repeat(40)}\n\nnot the footer`
  ])('fails closed for invalid published source metadata (%s)', (message) => {
    const repo = repository();
    const head = repo.commit('feat: first');
    repo.artifact('v2.0.0', head, { message });
    expect(() => repo.history()).toThrow('Source-Commit');
  });

  it('rejects unknown and unrelated source commits', () => {
    const repo = repository();
    const head = repo.commit('feat: first');
    repo.artifact('v2.0.0', 'f'.repeat(40));
    expect(() => repo.history()).toThrow('must exist and be an ancestor');
    repo.releases.length = 0;
    const unrelated = repo.artifact('v2.0.0-rc.1', head, { published: false });
    repo.artifact('v2.1.0', unrelated);
    expect(() => repo.history()).toThrow('must exist and be an ancestor');
  });

  it('rejects source baselines newer than HEAD and backwards version-to-source chronology', () => {
    const repo = repository();
    const first = repo.commit('feat: first');
    const second = repo.commit('fix: second');
    repo.artifact('v2.0.0', second);
    repo.git([
      'switch',
      '--detach',
      first
    ]);
    expect(() => repo.history()).toThrow('must exist and be an ancestor');
    repo.git([
      'switch',
      'main'
    ]);
    repo.artifact('v2.1.0', first);
    expect(() => repo.history()).toThrow('must exist and be an ancestor');
  });

  it('sorts stable versions numerically and rejects an RC source older than the stable baseline', () => {
    const repo = repository();
    const first = repo.commit('feat: first');
    repo.artifact('v2.9.0', first);
    const second = repo.commit('feat: second');
    repo.artifact('v2.10.0', second);
    repo.artifact('v2.10.1-rc.1', first);
    expect(repo.history().stable.map((release) => release.version)).toEqual([
      'v2.9.0',
      'v2.10.0'
    ]);
    expect(() => latestCandidate(repo.history(), 'v2.10.1', repo.cwd)).toThrow('must exist and be an ancestor');
  });

  it('rejects a published release without a locally fetched tag', () => {
    const repo = repository();
    repo.commit('feat: first');
    repo.releases.push({ tag_name: 'v2.0.0', draft: false, prerelease: false });
    expect(() => repo.history()).toThrow();
  });

  it('rejects a source change between history resolution and notes generation', () => {
    const repo = repository();
    repo.commit('feat: first');
    const history = repo.history();
    repo.commit('fix: changed');
    expect(() =>
      buildReleaseNotes({
        history,
        context: [{ commits: [] }],
        mode: 'rc',
        cliff: recorder(repo).cliff,
        cwd: repo.cwd
      })
    ).toThrow('Source HEAD changed');
  });

  it('validates source footers and rejects accidental multi-release git-cliff contexts', () => {
    expect(readSourceCommit(`chore(release): v2.0.0\r\n\r\nSource-Commit: ${'A'.repeat(40)}\r\n`)).toBe('a'.repeat(40));
    expect(() =>
      releaseContext(
        [
          { commits: [] },
          { commits: [] }
        ],
        undefined,
        'head'
      )
    ).toThrow('tag-free');
  });
});

describe('F3 workflow wiring', () => {
  it.each([
    'prerelease.yml',
    'prepare-release.yml'
  ])('uses source metadata and the pinned CLI in %s', (file) => {
    const text = fs.readFileSync(path.resolve('.github', 'workflows', file), 'utf8');
    const workflow = yaml.load(text);
    const job = Object.values(workflow.jobs).find((item) => item.steps.some((step) => step.id === 'history'));
    const steps = job.steps;
    expect(steps.find((step) => step.id === 'history').with.script).toContain('release-history.mjs');
    const install = steps.find((step) => step.uses?.startsWith('orhun/git-cliff-action@'));
    expect(install.with.version).toBe('v2.14.1');
    expect(install.with.args).toContain("--tag-pattern '^$'");
    expect(install.with.args).not.toContain('--context');
    const notes = steps.find((step) => step.with?.script?.includes('release-notes.mjs'));
    expect(notes.env.INPUT_HISTORY).toBe('${{ steps.history.outputs.history }}');
    expect(notes.env.INPUT_CLI_PATH).toBe('${{ runner.temp }}/git-cliff/bin/git-cliff');
    expect(text).not.toContain('--unreleased');
    expect(workflow.concurrency.group).toBe(
      file === 'prerelease.yml' ?
        "prerelease-${{ github.event.workflow_run.head_branch || 'main' }}"
      : 'prepare-release'
    );
  });
});

const binary = process.env.RELEASE_TEST_GIT_CLIFF;
(binary ? it : it.skip)('verifies first/stable/RC/no-op bumps with pinned git-cliff 2.14.1', { timeout: 60000 }, () => {
  expect(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()).toBe('git-cliff 2.14.1');
  const repo = repository();
  const cliff = (args, input) =>
    execFileSync(
      binary,
      [
        '--config',
        configPath,
        ...args
      ],
      {
        cwd: repo.cwd,
        input,
        encoding: 'utf8',
        stdio: [
          'pipe',
          'pipe',
          'pipe'
        ]
      }
    );
  const initial = repo.commit('feat!: original breaking implementation');
  expect(calculate(repo, 'rc', cliff).rcTag).toBe('v2.0.0-rc.1');
  repo.artifact('v2.0.0-rc.1', initial);
  expect(calculate(repo, 'rc', cliff).skip).toBe(true);
  repo.commit('chore(deps): ignored before preparation');
  expect(calculate(repo, 'rc', cliff).skip).toBe(true);
  expect(calculate(repo, 'stable', cliff).version).toBe('v2.0.0');
  repo.artifact('v2.0.0', initial);
  repo.commit('chore(release): v2.0.0');
  expect(calculate(repo, 'rc', cliff).skip).toBe(true);

  const firstPatch = repo.commit('fix: first patch');
  const patch = calculate(repo, 'rc', cliff);
  expect(patch.version).toBe('v2.0.1');
  expect(patch.content).not.toContain('Original breaking implementation');
  expect(patch.content).not.toContain('1970-01-01');
  repo.artifact('v2.0.1-rc.1', firstPatch);
  const secondPatch = repo.commit('fix: incremental patch');
  const rc = calculate(repo, 'rc', cliff);
  expect(rc.rcTag).toBe('v2.0.1-rc.2');
  expect(rc.content).toContain('Incremental patch');
  expect(rc.content).not.toContain('First patch');
  expect(rc.content).toContain(`${firstPatch}...${secondPatch}`);
  repo.artifact('v2.0.1-rc.2', secondPatch);
  const stable = calculate(repo, 'stable', cliff);
  expect(stable.content).toContain('First patch');
  expect(stable.content).toContain('Incremental patch');
  expect(stable.content).not.toContain('Original breaking implementation');
  expect(stable.changelog.match(/Original breaking implementation/g)).toHaveLength(1);
  repo.artifact('v2.0.1', secondPatch);

  repo.commit('feat: new capability');
  expect(calculate(repo, 'rc', cliff).version).toBe('v2.1.0');
  repo.commit('feat!: new breaking capability');
  expect(calculate(repo, 'rc', cliff).version).toBe('v3.0.0');
});

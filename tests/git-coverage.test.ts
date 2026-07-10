import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { getOctokitOptions } from '@actions/github/lib/utils';
import * as os from 'os';

const mocks = vi.hoisted(() => ({
  execGit: vi.fn(),
  execGitBuffer: vi.fn().mockResolvedValue(Buffer.alloc(0)),
  remove: vi.fn().mockResolvedValue(undefined),
  getOctokitOptions: vi.fn((_token: string, options: unknown) => options),
  context: {
    eventName: 'workflow_dispatch',
    payload: {} as Record<string, unknown>
  },
  api: {
    repos: {
      createFork: vi.fn(),
      compareCommits: vi.fn()
    },
    users: {
      getAuthenticated: vi.fn()
    },
    pulls: {
      list: vi.fn(),
      listFiles: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      requestReviewers: vi.fn()
    },
    issues: {
      addLabels: vi.fn(),
      addAssignees: vi.fn()
    },
    git: {
      createBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      createRef: vi.fn(),
      updateRef: vi.fn(),
      deleteRef: vi.fn()
    }
  }
}));

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

vi.mock('@actions/github', () => ({
  context: mocks.context
}));

vi.mock('@actions/github/lib/utils', () => ({
  GitHub: {
    plugin: vi.fn(() => {
      return class MockOctokit {
        rest = mocks.api;
      };
    })
  },
  getOctokitOptions: mocks.getOctokitOptions
}));

vi.mock('@octokit/plugin-throttling', () => ({
  throttling: vi.fn()
}));

vi.mock('../src/config.js', () => ({
  default: {
    GITHUB_TOKEN: 'test-token',
    GITHUB_SERVER_URL: 'https://github.com',
    IS_INSTALLATION_TOKEN: false,
    IS_FINE_GRAINED: false,
    GIT_USERNAME: 'test-user',
    GIT_EMAIL: 'test@example.com',
    TMP_DIR: os.tmpdir(),
    COMMIT_BODY: '',
    COMMIT_PREFIX: 'sync:',
    GITHUB_REPOSITORY: 'owner/repo',
    OVERWRITE_EXISTING_PR: true,
    SKIP_PR: false,
    PR_BODY: 'PR body',
    BRANCH_PREFIX: 'sync/',
    FORK: undefined,
    REBASE: false
  }
}));

vi.mock('../src/helpers.js', () => ({
  dedent: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, value, index) => result + value + (values[index] ?? ''), '')
  ),
  execGit: mocks.execGit,
  execGitBuffer: mocks.execGitBuffer,
  remove: mocks.remove
}));

import Git from '../src/git.js';
import type { RepoInfo } from '../src/types.js';

const repo: RepoInfo = {
  url: 'https://github.com/test/repo',
  fullName: 'github.com/test/repo',
  uniqueName: 'github.com/test/repo@main',
  host: 'github.com',
  user: 'test',
  name: 'repo',
  branch: 'main'
};

interface GitInternals {
  github: typeof mocks.api;
  existingPr?: { number: number; html_url: string; body: string | null };
  prBranch?: string;
  prBranchSuffix?: string;
  baseBranch: string;
  lastCommitSha: string;
  lastCommitChanges?: Record<string, string>;
  remoteBranchHead?: string;
  forceUpdateBranch: boolean;
  reopenClosedPr: boolean;
  prWasReopened: boolean;
  getAllChangedFiles(): Promise<string>;
  isBranchBehindBase(branch: string): Promise<boolean>;
}

const internals = (git: Git): GitInternals => git as unknown as GitInternals;

function defaultExec(args: string[]): Promise<string> {
  const command = args.join(' ');
  if (command === 'rev-list -n 1 --all') return Promise.resolve('base-sha');
  if (command === 'rev-parse --abbrev-ref HEAD') return Promise.resolve('main');
  if (command === 'rev-parse HEAD') return Promise.resolve('base-sha');
  return Promise.resolve('');
}

async function initializedGit(): Promise<Git> {
  const git = new Git();
  await git.initRepo(repo);
  return git;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['GITHUB_API_URL'];
  delete process.env['GITHUB_RUN_ID'];
  mocks.context.eventName = 'workflow_dispatch';
  mocks.context.payload = {};
  mocks.execGit.mockImplementation(defaultExec);
  mocks.getOctokitOptions.mockImplementation((_token: string, options: unknown) => options);
  mocks.api.users.getAuthenticated.mockResolvedValue({ data: { login: 'test', email: 'test@example.com' } });
  mocks.api.pulls.list.mockResolvedValue({ data: [] });
  mocks.api.pulls.listFiles.mockResolvedValue({ data: [] });
  mocks.api.pulls.create.mockResolvedValue({ data: { number: 1, html_url: 'https://example/pull/1', body: null } });
  mocks.api.pulls.update.mockResolvedValue({ data: { number: 1, html_url: 'https://example/pull/1', body: null } });
  mocks.api.git.createTree.mockResolvedValue({ data: { sha: 'tree-sha' } });
  mocks.api.git.createCommit.mockResolvedValue({ data: { sha: 'commit-sha' } });
  mocks.api.git.createRef.mockResolvedValue({ data: {} });
  mocks.api.git.updateRef.mockResolvedValue({ data: {} });
});

describe('git.ts - standard coverage', () => {
  it('configures and executes both throttling callbacks with a custom API URL', () => {
    process.env['GITHUB_API_URL'] = 'https://ghe.example/api/v3';
    new Git();

    const options = vi.mocked(getOctokitOptions).mock.calls.at(-1)?.[1] as {
      baseUrl: string;
      throttle: {
        onRateLimit(retryAfter: number): boolean;
        onSecondaryRateLimit(retryAfter: number): boolean;
      };
    };

    expect(options.baseUrl).toBe('https://ghe.example/api/v3');
    expect(options.throttle.onRateLimit(2)).toBe(true);
    expect(options.throttle.onSecondaryRateLimit(3)).toBe(true);
    expect(core.debug).toHaveBeenCalledWith('Hit GitHub API rate limit, retrying after 2s');
    expect(core.debug).toHaveBeenCalledWith('Hit secondary GitHub API rate limit, retrying after 3s');
  });

  it('sanitizes control characters, invalid characters, dots, and empty path segments', () => {
    const gitClass = Git as unknown as { toSafePathSegment(input: string): string };

    expect(gitClass.toSafePathSegment(' branch\u0001<>:name... ')).toBe('branch____name');
    expect(gitClass.toSafePathSegment('   ')).toBe('default');
    expect(gitClass.toSafePathSegment('...')).toBe('default');
  });

  it('normalizes literal Windows pathspecs', async () => {
    const git = await initializedGit();

    await git.add('folder\\file.txt');

    expect(mocks.execGit).toHaveBeenCalledWith(['add', '-f', '--', ':(literal)folder/file.txt'], git.workingDir);
  });

  it('skips cleanup removal when disabled or before initialization', async () => {
    const git = await initializedGit();
    await git.cleanupRepo(repo, false);
    await new Git().cleanupRepo(repo);

    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('detects one-commit pushes and reads optional commit messages', () => {
    const git = new Git();
    mocks.context.eventName = 'push';
    mocks.context.payload = { commits: [{ message: 'first' }] };
    expect(git.isOneCommitPush()).toBe(true);
    expect(git.originalCommitMessage()).toBe('first');

    mocks.context.payload = { commits: [{}, { message: 'second' }] };
    expect(git.isOneCommitPush()).toBe(false);
    expect(git.originalCommitMessage()).toBe('');

    mocks.context.eventName = 'workflow_dispatch';
    mocks.context.payload = {};
    expect(git.isOneCommitPush()).toBe(false);
    expect(git.originalCommitMessage()).toBe('');
  });

  it('parses text, deleted, and binary diff entries', () => {
    const git = new Git();
    const result = git.parseGitDiffOutput(`
diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
diff --git a/deleted.txt b/deleted.txt
--- a/deleted.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`);

    expect(result['file.txt']).toContain('+new');
    expect(result['deleted.txt']).toContain('-gone');
    expect(result).not.toHaveProperty('image.png');
  });

  it('retains an empty path for a malformed deletion header without a previous line', () => {
    const git = new Git();

    expect(git.parseGitDiffOutput('diff --git+++ /dev/null\n@@ -1 +0,0 @@\n-gone')).toEqual({ '': '@@ -1 +0,0 @@\n-gone' });
  });

  it('fetches, caches, and filters source changes', async () => {
    const git = await initializedGit();
    mocks.context.payload = {
      repository: { owner: { name: 'source-owner' }, name: 'source-repo' },
      before: 'before-sha',
      after: 'after-sha'
    };
    mocks.api.repos.compareCommits.mockResolvedValue({
      data: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n` +
        `diff --git a/docs/readme.md b/docs/readme.md\n--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -1 +1 @@\n-old\n+new`
    });

    expect(await git.getChangesFromLastCommit('src/')).toHaveLength(1);
    expect(await git.getChangesFromLastCommit('src/a.ts')).toHaveLength(1);
    expect(await git.getChangesFromLastCommit('missing.txt')).toEqual([]);
    expect(mocks.api.repos.compareCommits).toHaveBeenCalledTimes(1);
  });

  it('uses empty repository metadata defaults when comparing source changes', async () => {
    const git = await initializedGit();
    mocks.context.payload = { before: 'before', after: 'after' };
    mocks.api.repos.compareCommits.mockResolvedValue({ data: '' });

    await git.getChangesFromLastCommit('missing.txt');

    expect(mocks.api.repos.compareCommits).toHaveBeenCalledWith(expect.objectContaining({ owner: '', repo: '' }));
  });

  it('returns parsed destination changes and working-tree state', async () => {
    const git = await initializedGit();
    mocks.execGit.mockImplementation((args: string[]) => {
      if (args[0] === 'diff') {
        return Promise.resolve('diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new');
      }
      if (args.join(' ') === 'status --porcelain') return Promise.resolve(' M file.txt ');
      return defaultExec(args);
    });

    expect(await git.changes('file.txt')).toHaveLength(1);
    expect(await git.hasChanges()).toBe(true);
    mocks.execGit.mockResolvedValueOnce('   ');
    expect(await git.hasChanges()).toBe(false);
  });

  it('uses the default commit message and returns status and commit messages', async () => {
    const git = await initializedGit();
    mocks.execGit.mockResolvedValue('result');

    await git.commit();
    expect(await git.status()).toBe('result');
    expect(await git.getCommitMessage('abc')).toBe('result');

    expect(mocks.execGit).toHaveBeenCalledWith(['commit', '-m', 'sync: synced file(s) with owner/repo'], git.workingDir);
    expect(mocks.execGit).toHaveBeenCalledWith(['status'], git.workingDir);
    expect(mocks.execGit).toHaveBeenCalledWith(['log', '-1', '--format=%B', 'abc'], git.workingDir);
  });

  it('extracts a tree id and returns an empty value when the header is absent', async () => {
    const git = await initializedGit();
    mocks.execGit.mockResolvedValueOnce('tree tree-123\nparent parent-123\n\nmessage');
    expect(await git.getTreeId('commit')).toBe('tree-123');

    mocks.execGit.mockResolvedValueOnce('parent parent-123\n\nmessage');
    expect(await git.getTreeId('commit')).toBe('');
  });

  it('ignores empty tree-diff metadata and supplies defaults for missing fields', async () => {
    const git = new Git();
    mocks.execGit.mockResolvedValue('\0ignored\0:\0file.txt\0');

    expect(await git.getTreeDiff('current', 'previous')).toEqual([
      { newMode: '', previousMode: '', newBlob: '', previousBlob: '', change: '', path: 'file.txt' }
    ]);
  });

  it('creates verified commits, tolerates an existing ref, and updates the PR ref', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.prBranch = 'sync/main';
    state.lastCommitSha = 'base-sha';
    vi.spyOn(git, 'getCommitsToPush').mockResolvedValue(['one', 'two']);
    const createCommit = vi.spyOn(git, 'createGithubCommit').mockImplementation(async (sha) => {
      state.lastCommitSha = `${sha}-remote`;
    });
    mocks.api.git.createRef.mockRejectedValue(new Error('Reference already exists'));

    await git.createGithubVerifiedCommits();

    expect(createCommit).toHaveBeenCalledTimes(2);
    expect(mocks.api.git.updateRef).toHaveBeenCalledWith({
      owner: 'test',
      repo: 'repo',
      ref: 'heads/sync/main',
      sha: 'two-remote',
      force: false
    });
  });

  it('creates a new verified-commit branch ref', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.prBranch = 'sync/main';
    state.lastCommitSha = 'base-sha';
    vi.spyOn(git, 'getCommitsToPush').mockResolvedValue([]);

    await git.createGithubVerifiedCommits();

    expect(mocks.api.git.createRef).toHaveBeenCalledWith({
      owner: 'test',
      repo: 'repo',
      sha: 'base-sha',
      ref: 'refs/heads/sync/main'
    });
  });

  it('rethrows unexpected branch-ref creation failures', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.prBranch = 'sync/main';
    state.lastCommitSha = 'base-sha';
    vi.spyOn(git, 'getCommitsToPush').mockResolvedValue([]);
    mocks.api.git.createRef.mockRejectedValue(new Error('permission denied'));

    await expect(git.createGithubVerifiedCommits()).rejects.toThrow('permission denied');
  });

  it('skips a failed remote-head check and uses an unqualified force lease', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.prBranch = 'sync/main';
    state.forceUpdateBranch = true;
    mocks.execGit.mockImplementation((args: string[]) => {
      if (args[0] === 'fetch') return Promise.reject(new Error('offline'));
      return defaultExec(args);
    });

    await git.push();

    expect(core.debug).toHaveBeenCalledWith(expect.stringContaining('Remote branch check skipped'));
    expect(mocks.execGit).toHaveBeenCalledWith(
      ['push', '--force-with-lease', expect.stringContaining('test-token@github.com/test/repo.git'), 'HEAD:refs/heads/sync/main'],
      git.workingDir
    );
  });

  it('pushes normally when no pull-request branch has been created', async () => {
    const git = await initializedGit();

    await git.push();

    expect(mocks.execGit).toHaveBeenCalledWith(
      ['push', expect.stringContaining('test-token@github.com/test/repo.git')],
      git.workingDir
    );
  });

  it('handles remote deletion and behind-base comparison failures conservatively', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.baseBranch = 'main';
    mocks.api.repos.compareCommits.mockRejectedValue(new Error('offline'));
    mocks.api.git.deleteRef.mockRejectedValue(new Error('not found'));

    expect(await state.isBranchBehindBase('sync/main')).toBe(false);
    await git.deleteRemoteBranch('sync/main');

    expect(core.debug).toHaveBeenCalledWith(expect.stringContaining('Could not determine if sync/main is behind main'));
    expect(core.debug).toHaveBeenCalledWith(expect.stringContaining('Failed to delete remote branch sync/main'));
  });

  it('treats a missing ahead count as not behind', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.baseBranch = 'main';
    mocks.api.repos.compareCommits.mockResolvedValue({ data: {} });

    expect(await state.isBranchBehindBase('sync/main')).toBe(false);
  });

  it('adds and removes pull-request resync warnings, including null bodies', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.existingPr = { number: 5, html_url: 'https://example/pull/5', body: null };

    await git.setPrWarning();
    expect(mocks.api.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 5, body: expect.stringContaining('automatically resynced') })
    );

    await git.removePrWarning();
    expect(mocks.api.pulls.update).toHaveBeenLastCalledWith(expect.objectContaining({ body: '' }));

    state.existingPr.body = '⚠️ This PR is being automatically resynced (2026-01-01T00:00:00.000Z) ⚠️\nbody';
    await git.removePrWarning();
    expect(mocks.api.pulls.update).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.not.stringContaining('⚠️') }));
  });

  it('does not update warnings or metadata without an existing pull request', async () => {
    const git = await initializedGit();

    await git.setPrWarning();
    await git.removePrWarning();
    await git.addPrLabels(['sync']);
    await git.addPrAssignees(['alice']);
    await git.addPrReviewers(['bob']);
    await git.addPrTeamReviewers(['team']);

    expect(mocks.api.pulls.update).not.toHaveBeenCalled();
    expect(mocks.api.issues.addLabels).not.toHaveBeenCalled();
    expect(mocks.api.issues.addAssignees).not.toHaveBeenCalled();
    expect(mocks.api.pulls.requestReviewers).not.toHaveBeenCalled();
  });

  it('updates labels, assignees, user reviewers, and team reviewers', async () => {
    const git = await initializedGit();
    internals(git).existingPr = { number: 8, html_url: 'https://example/pull/8', body: 'body' };

    await git.addPrLabels(['sync']);
    await git.addPrAssignees(['alice']);
    await git.addPrReviewers(['bob']);
    await git.addPrTeamReviewers(['platform']);

    expect(mocks.api.issues.addLabels).toHaveBeenCalledWith({ owner: 'test', repo: 'repo', issue_number: 8, labels: ['sync'] });
    expect(mocks.api.issues.addAssignees).toHaveBeenCalledWith({ owner: 'test', repo: 'repo', issue_number: 8, assignees: ['alice'] });
    expect(mocks.api.pulls.requestReviewers).toHaveBeenCalledWith({ owner: 'test', repo: 'repo', pull_number: 8, reviewers: ['bob'] });
    expect(mocks.api.pulls.requestReviewers).toHaveBeenCalledWith({ owner: 'test', repo: 'repo', pull_number: 8, team_reviewers: ['platform'] });
  });

  it('returns no changed-file markup without an existing pull request', async () => {
    const git = await initializedGit();

    expect(await internals(git).getAllChangedFiles()).toBe('');
  });

  it('uses the branch suffix in a generated pull-request title', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.prBranch = 'sync/main-docs';
    state.prBranchSuffix = 'docs';
    state.baseBranch = 'main';

    await git.createOrUpdatePr('changed');

    expect(mocks.api.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'sync: synced file(s) with owner/repo (docs)' })
    );
  });

  it('creates a deletion-only GitHub commit and reports tree creation failures', async () => {
    const git = await initializedGit();
    const state = internals(git);
    state.lastCommitSha = 'parent-commit';
    vi.spyOn(git, 'getTreeId').mockResolvedValueOnce('current-tree').mockResolvedValueOnce('parent-tree');
    vi.spyOn(git, 'getCommitMessage').mockResolvedValue('delete file');
    vi.spyOn(git, 'getTreeDiff').mockResolvedValue([
      {
        newMode: '000000',
        previousMode: '100644',
        newBlob: '0000000000000000000000000000000000000000',
        previousBlob: 'old-blob',
        change: 'D',
        path: 'old.txt'
      }
    ]);

    await git.createGithubCommit('local-commit');
    expect(mocks.api.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree: [{ path: 'old.txt', mode: '100644', type: 'blob', sha: null }] })
    );
    expect(state.lastCommitSha).toBe('commit-sha');

    mocks.api.git.createTree.mockRejectedValueOnce(new Error('invalid tree'));
    await expect(git.createGithubCommit('local-commit')).rejects.toThrow('Cannot create a new GitHub Tree: invalid tree');
  });
});
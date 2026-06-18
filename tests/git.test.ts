import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as core from '@actions/core';
import * as os from 'os';

// Hoist mocks to be available before module imports
const { execGitMock, removeMock } = vi.hoisted(() => ({
  execGitMock: vi.fn().mockResolvedValue(''),
  removeMock: vi.fn().mockResolvedValue(undefined)
}));

// Mock external dependencies before importing Git
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' }
  },
  getOctokit: vi.fn()
}));

vi.mock('@actions/github/lib/utils', () => ({
  GitHub: {
    plugin: vi.fn(() => {
      return class MockOctokit {
        rest = {
          repos: {
            createFork: vi.fn(),
            get: vi.fn()
          },
          users: {
            getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'test', email: 'test@test.com' } })
          },
          pulls: {
            list: vi.fn().mockResolvedValue({ data: [] }),
            listFiles: vi.fn().mockResolvedValue({ data: [] }),
            create: vi.fn().mockResolvedValue({ data: { number: 1, html_url: 'https://github.com/test/repo/pull/1' } }),
            update: vi.fn()
          },
          issues: {
            addLabels: vi.fn(),
            addAssignees: vi.fn()
          },
          git: {
            getCommit: vi.fn(),
            getTree: vi.fn(),
            createTree: vi.fn(),
            createCommit: vi.fn(),
            updateRef: vi.fn(),
            deleteRef: vi.fn()
          }
        };
      };
    })
  },
  getOctokitOptions: vi.fn(() => ({}))
}));

vi.mock('@octokit/plugin-throttling', () => ({
  throttling: vi.fn()
}));

// Mock config module
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
    COMMIT_PREFIX: '',
    GITHUB_REPOSITORY: 'owner/repo',
    OVERWRITE_EXISTING_PR: true,
    SKIP_PR: false,
    PR_BODY: 'PR body',
    BRANCH_PREFIX: 'sync/',
    FORK: undefined
  }
}));

// Mock helpers using hoisted mocks
vi.mock('../src/helpers.js', () => ({
  dedent: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (typeof strings === 'string') return strings;
    return strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), '');
  }),
  execGit: execGitMock,
  remove: removeMock
}));

import Git from '../src/git.js';
import type { RepoInfo } from '../src/types.js';

describe('git.ts - Git class', () => {
  let git: Git;

  const mockRepoInfo: RepoInfo = {
    url: 'https://github.com/test/repo',
    fullName: 'github.com/test/repo',
    uniqueName: 'github.com/test/repo@main',
    host: 'github.com',
    user: 'test',
    name: 'repo',
    branch: 'main'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    git = new Git();
  });

  describe('constructor', () => {
    it('should create Git instance', () => {
      expect(git).toBeInstanceOf(Git);
    });
  });

  describe('initRepo', () => {
    it('should initialize repository with correct working directory', async () => {
      execGitMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      // Working directory contains the unique name (with path separators)
      expect(git.workingDir).toContain('github.com');
      expect(git.workingDir).toContain('test');
      expect(git.workingDir).toContain('repo');
    });

    it('should call clone during init', async () => {
      execGitMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      // Clone is invoked with git args (no shell) starting with the clone subcommand
      const cloneCall = execGitMock.mock.calls.find(
        (call) => Array.isArray(call[0]) && call[0][0] === 'clone'
      );
      expect(cloneCall).toBeDefined();
      expect(cloneCall?.[0]).toContain('clone');
    });

    it('should set git identity during init', async () => {
      execGitMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      expect(execGitMock).toHaveBeenCalledWith(
        expect.arrayContaining(['config', '--local', 'user.name']),
        expect.any(String)
      );
    });

    it('should flag an empty repository and skip rev-parse calls', async () => {
      // `git rev-list -n 1 --all` returns nothing when the default branch has no commits yet
      execGitMock.mockImplementation((args: string[]) =>
        Promise.resolve(args[0] === 'rev-list' ? '' : 'main')
      );

      await git.initRepo(mockRepoInfo);

      expect(git.isEmptyRepo).toBe(true);
      expect(vi.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining('no commits'));

      // getBaseBranch / getLastCommitSha must not run on an empty repo
      const revParseCalls = execGitMock.mock.calls.filter(
        (call) => Array.isArray(call[0]) && call[0][0] === 'rev-parse'
      );
      expect(revParseCalls).toHaveLength(0);
    });

    it('should not flag a repository that has commits', async () => {
      execGitMock.mockImplementation((args: string[]) =>
        Promise.resolve(args[0] === 'rev-list' ? 'abc123' : 'main')
      );

      await git.initRepo(mockRepoInfo);

      expect(git.isEmptyRepo).toBe(false);
      expect(execGitMock).toHaveBeenCalledWith(['rev-parse', 'HEAD'], expect.any(String));
    });
  });

  describe('createPrBranch', () => {
    beforeEach(async () => {
      execGitMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should create branch with default naming', async () => {
      await git.createPrBranch();

      expect(execGitMock).toHaveBeenCalledWith(
        ['switch', expect.stringContaining('main')],
        expect.any(String)
      );
    });

    it('should append branch suffix when provided', async () => {
      await git.createPrBranch('custom-suffix');

      // Should include the suffix in the branch name
      expect(execGitMock).toHaveBeenCalledWith(
        ['switch', expect.stringContaining('custom-suffix')],
        expect.any(String)
      );
    });
  });

  describe('add', () => {
    beforeEach(async () => {
      execGitMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should add file to staging', async () => {
      await git.add('test-file.txt');

      expect(execGitMock).toHaveBeenCalledWith(
        ['add', '-f', 'test-file.txt'],
        expect.any(String)
      );
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      execGitMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should remove file from repo', async () => {
      await git.remove('test-file.txt');

      expect(execGitMock).toHaveBeenCalledWith(
        ['rm', '-f', 'test-file.txt'],
        expect.any(String)
      );
    });
  });

  describe('hasStagedChanges', () => {
    beforeEach(async () => {
      execGitMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should return true when there are staged changes', async () => {
      execGitMock.mockResolvedValueOnce('LICENSE\nREADME.md');

      const result = await git.hasStagedChanges();
      expect(result).toBe(true);

      expect(execGitMock).toHaveBeenCalledWith(
        ['diff', '--cached', '--name-only'],
        expect.any(String)
      );
    });

    it('should return false when there are no staged changes', async () => {
      execGitMock.mockResolvedValueOnce('');

      const result = await git.hasStagedChanges();
      expect(result).toBe(false);
    });

    it('should return false when only unstaged changes exist', async () => {
      // git diff --cached --name-only returns empty when changes are unstaged
      execGitMock.mockResolvedValueOnce('');

      const result = await git.hasStagedChanges();
      expect(result).toBe(false);
    });
  });

  describe('commit', () => {
    beforeEach(async () => {
      execGitMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should commit using git arguments so shell metacharacters are safe', async () => {
      const message = "chore(sync): synced file(s) with radius-project/.github's workflows";

      await git.commit(message);

      expect(execGitMock).toHaveBeenCalledWith(['commit', '-m', message], expect.any(String));
    });
  });

  describe('cleanupRepo', () => {
    beforeEach(async () => {
      execGitMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should remove working directory', async () => {
      await git.cleanupRepo(mockRepoInfo);

      expect(removeMock).toHaveBeenCalledWith(git.workingDir);
    });
  });

  describe('branch operations', () => {
    beforeEach(async () => {
      execGitMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should fetch all branches when creating PR branch with overwrite', async () => {
      await git.createPrBranch();

      expect(execGitMock).toHaveBeenCalledWith(
        ['remote', 'set-branches', 'origin', '*'],
        expect.any(String)
      );

      expect(execGitMock).toHaveBeenCalledWith(
        ['fetch', '-v', '--depth=1'],
        expect.any(String)
      );
    });
  });

  describe('clone', () => {
    it('should clone with branch option when branch is not default', async () => {
      execGitMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      const cloneCall = execGitMock.mock.calls.find(
        (call) => Array.isArray(call[0]) && call[0][0] === 'clone'
      );
      expect(cloneCall?.[0]).toContain('--branch');
      expect(cloneCall?.[0]).toContain('main');
    });

    it('should clone without branch option when branch is default', async () => {
      const defaultBranchRepo: RepoInfo = {
        ...mockRepoInfo,
        branch: 'default'
      };

      execGitMock.mockResolvedValue('main');

      await git.initRepo(defaultBranchRepo);

      // Should not include --branch option
      const cloneCall = execGitMock.mock.calls.find(
        (call) => Array.isArray(call[0]) && call[0][0] === 'clone'
      );
      expect(cloneCall?.[0]).not.toContain('--branch');
    });
  });

  describe('getBaseBranch', () => {
    it('should get current branch name', async () => {
      execGitMock.mockImplementation((args: string[]) => {
        if (Array.isArray(args) && args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          return Promise.resolve('main');
        }
        // Non-empty rev-list output so the repo isn't treated as empty
        if (Array.isArray(args) && args[0] === 'rev-list') {
          return Promise.resolve('abc123');
        }
        return Promise.resolve('');
      });

      await git.initRepo(mockRepoInfo);

      expect(execGitMock).toHaveBeenCalledWith(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        expect.any(String)
      );
    });
  });
});

describe('git.ts - edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('branch name sanitization', () => {
    it('should handle special characters in branch name', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('feature/test');

      const repoWithSpecialBranch: RepoInfo = {
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@feature/test',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'feature/test'
      };

      await git.initRepo(repoWithSpecialBranch);

      const cloneCall = execGitMock.mock.calls.find(
        (call) => Array.isArray(call[0]) && call[0][0] === 'clone'
      );
      expect(cloneCall?.[0]).toContain('--branch');
      expect(cloneCall?.[0]).toContain('feature/test');
    });
  });

  describe('working directory path', () => {
    it('should use unique name for working directory', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/org/unique-repo',
        fullName: 'github.com/org/unique-repo',
        uniqueName: 'github.com/org/unique-repo@develop',
        host: 'github.com',
        user: 'org',
        name: 'unique-repo',
        branch: 'develop'
      });

      expect(git.workingDir).toContain('github.com');
      expect(git.workingDir).toContain('org');
      expect(git.workingDir).toContain('unique-repo');
    });
  });

  describe('getCommitsToPush', () => {
    it('should use lastCommitSha as base ref to avoid shallow clone issues', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // Simulate lastCommitSha being set (it's set during initRepo via getLastCommitSha)
      // Now call getCommitsToPush
      execGitMock.mockResolvedValueOnce('abc123\ndef456');

      const commits = await (git as unknown as { getCommitsToPush: () => Promise<string[]> }).getCommitsToPush();

      // Verify it uses lastCommitSha (which is 'main' from mock) not baseBranch
      const logCall = execGitMock.mock.calls.find(
        (call) => Array.isArray(call[0]) && call[0][0] === 'log'
      );
      expect(logCall).toBeDefined();
      expect(logCall?.[0]).toContain('main..HEAD');
      expect(commits).toEqual(['abc123', 'def456']);
    });

    it('should filter empty strings from git log output', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // Empty output (no new commits)
      execGitMock.mockResolvedValueOnce('');

      const commits = await (git as unknown as { getCommitsToPush: () => Promise<string[]> }).getCommitsToPush();
      expect(commits).toEqual([]);
    });
  });

  describe('getAllChangedFiles', () => {
    it('should return all files changed in the existing pull request', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gitAny = git as any;
      gitAny.existingPr = { number: 5, html_url: 'https://github.com/test/repo/pull/5', body: null };
      gitAny.github.pulls.listFiles.mockResolvedValueOnce({
        data: [
          { filename: 'file-a.txt' },
          { filename: 'file-b.txt' },
          { filename: 'file-c.txt' },
          { filename: 'file-d.txt' },
          { filename: 'file-e.txt' }
        ]
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (git as any).getAllChangedFiles();

      expect(result).toContain('file-a.txt');
      expect(result).toContain('file-b.txt');
      expect(result).toContain('file-c.txt');
      expect(result).toContain('file-d.txt');
      expect(result).toContain('file-e.txt');
      expect(result).toContain('<details>');
      expect(result).toContain('Changed files');
      expect(gitAny.github.pulls.listFiles).toHaveBeenCalledWith({
        owner: 'test',
        repo: 'repo',
        pull_number: 5,
        per_page: 100,
        page: 1
      });
    });

    it('should return empty string when no files changed', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gitAny = git as any;
      gitAny.existingPr = { number: 5, html_url: 'https://github.com/test/repo/pull/5', body: null };
      gitAny.github.pulls.listFiles.mockResolvedValueOnce({ data: [] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (git as any).getAllChangedFiles();

      expect(result).toBe('');
    });

    it('should paginate pull request files', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gitAny = git as any;
      gitAny.existingPr = { number: 5, html_url: 'https://github.com/test/repo/pull/5', body: null };
      gitAny.github.pulls.listFiles
        .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, index) => ({ filename: `file-${index}.txt` })) })
        .mockResolvedValueOnce({ data: [{ filename: 'last-file.txt' }] });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (git as any).getAllChangedFiles();

      expect(result).toContain('file-0.txt');
      expect(result).toContain('last-file.txt');
      expect(gitAny.github.pulls.listFiles).toHaveBeenCalledTimes(2);
    });
  });

  describe('closed PR handling', () => {
    it('should detect closed unmerged PR and delete remote branch', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gitAny = git as any;

      // Mock pulls.list to return a closed unmerged PR
      gitAny.github.pulls.list.mockResolvedValue({
        data: [{ number: 10, html_url: 'https://github.com/test/repo/pull/10', body: 'old', merged_at: null }]
      });

      const hasClosed = await git.hasClosedPr();
      expect(hasClosed).toBe(true);
    });

    it('should not flag merged PRs as closed', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gitAny = git as any;

      // Mock pulls.list to return a merged PR
      gitAny.github.pulls.list.mockResolvedValue({
        data: [{ number: 10, html_url: 'https://github.com/test/repo/pull/10', body: 'old', merged_at: '2026-01-01T00:00:00Z' }]
      });

      const hasClosed = await git.hasClosedPr();
      expect(hasClosed).toBe(false);
    });

    it('should return false when no closed PRs exist', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gitAny = git as any;

      gitAny.github.pulls.list.mockResolvedValue({ data: [] });

      const hasClosed = await git.hasClosedPr();
      expect(hasClosed).toBe(false);
    });

    it('should call deleteRef when deleting remote branch', async () => {
      const git = new Git();
      execGitMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gitAny = git as any;
      gitAny.github.git.deleteRef.mockResolvedValue({});

      await git.deleteRemoteBranch('sync/repo/main');

      expect(gitAny.github.git.deleteRef).toHaveBeenCalledWith({
        owner: 'test',
        repo: 'repo',
        ref: 'heads/sync/repo/main'
      });
    });
  });
});

describe('git.ts - closed PR reopen handling', () => {
  const mockRepoInfo: RepoInfo = {
    url: 'https://github.com/test/repo',
    fullName: 'github.com/test/repo',
    uniqueName: 'github.com/test/repo@main',
    host: 'github.com',
    user: 'test',
    name: 'repo',
    branch: 'main'
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getClosedPr should return the most recent unmerged closed PR', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.github.pulls.list.mockResolvedValue({
      data: [
        { number: 10, html_url: 'https://github.com/test/repo/pull/10', body: 'older', merged_at: null },
        { number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'newer', merged_at: null }
      ]
    });

    const closed = await git.getClosedPr();

    expect(closed).toEqual({
      number: 12,
      html_url: 'https://github.com/test/repo/pull/12',
      body: 'newer'
    });
  });

  it('getClosedPr should ignore merged PRs', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.github.pulls.list.mockResolvedValue({
      data: [{ number: 10, html_url: 'https://github.com/test/repo/pull/10', body: 'm', merged_at: '2026-01-01T00:00:00Z' }]
    });

    expect(await git.getClosedPr()).toBeUndefined();
  });

  it('createPrBranch should rebuild the branch and flag reopen when a closed PR exists', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    // Remote branch exists (rev-parse --verify succeeds)
    execGitMock.mockResolvedValue('abc123');
    // No open PR, but a stale closed PR exists for the branch
    gitAny.github.pulls.list.mockImplementation(({ state }: { state: string }) =>
      state === 'open'
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: [{ number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'old', merged_at: null }] })
    );

    await git.createPrBranch();

    expect(gitAny.existingPr).toEqual({
      number: 12,
      html_url: 'https://github.com/test/repo/pull/12',
      body: 'old'
    });
    expect(gitAny.reopenClosedPr).toBe(true);
    expect(gitAny.forceUpdateBranch).toBe(true);
    // Branch is rebuilt from the base tip with a force-create switch (-C)
    expect(execGitMock).toHaveBeenCalledWith(['switch', '-C', expect.stringContaining('main')], expect.any(String));
    // The remote branch must NOT be deleted anymore
    expect(gitAny.github.git.deleteRef).not.toHaveBeenCalled();
  });

  it('createPrBranch should NOT take the reopen path when an open PR exists (rebase wins)', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    // Remote branch exists
    execGitMock.mockResolvedValue('abc123');
    // A live open PR AND stale closed PRs both exist for the same branch
    gitAny.github.pulls.list.mockImplementation(({ state }: { state: string }) =>
      state === 'open'
        ? Promise.resolve({ data: [{ number: 99, html_url: 'https://github.com/test/repo/pull/99', body: 'live' }] })
        : Promise.resolve({ data: [{ number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'old', merged_at: null }] })
    );

    await git.createPrBranch();

    // The open PR is reused, not the closed one
    expect(gitAny.existingPr).toEqual({
      number: 99,
      html_url: 'https://github.com/test/repo/pull/99',
      body: 'live'
    });
    expect(gitAny.reopenClosedPr).toBe(false);
    // The remote branch must never be deleted for a live PR
    expect(gitAny.github.git.deleteRef).not.toHaveBeenCalled();
  });

  it('push reopens the closed PR before force-pushing its branch', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.prBranch = 'sync/repo/main';
    gitAny.existingPr = { number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'old' };
    gitAny.reopenClosedPr = true;
    gitAny.forceUpdateBranch = true;
    gitAny.github.pulls.update.mockResolvedValue({
      data: { number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'old' }
    });

    await git.push();

    // Reopen happens before the force-push, while the branch still matches the PR
    expect(gitAny.github.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 12, state: 'open' }));
    expect(gitAny.prWasReopened).toBe(true);
    expect(gitAny.reopenClosedPr).toBe(false);
    expect(gitAny.existingPr.number).toBe(12);
  });

  it('push drops the PR reference when GitHub refuses to reopen (branch was recreated)', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.prBranch = 'sync/repo/main';
    gitAny.existingPr = { number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'old' };
    gitAny.reopenClosedPr = true;
    gitAny.forceUpdateBranch = true;
    gitAny.github.pulls.update.mockRejectedValue(
      new Error('state cannot be changed. The repo-sync/default branch was force-pushed or recreated.')
    );

    await git.push();

    // A new PR will be created later (createOrUpdatePr) instead of reopening
    expect(gitAny.existingPr).toBeUndefined();
    expect(gitAny.prWasReopened).toBe(false);
    expect(gitAny.reopenClosedPr).toBe(false);
  });

  it('createOrUpdatePr reports the reopened action and does not change PR state', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.prBranch = 'sync/repo/main';
    gitAny.baseBranch = 'main';
    gitAny.existingPr = { number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'old' };
    gitAny.prWasReopened = true;
    gitAny.github.pulls.update.mockResolvedValue({
      data: { number: 12, html_url: 'https://github.com/test/repo/pull/12', body: 'new' }
    });

    const result = await git.createOrUpdatePr('');

    // State was already reopened in push(); this update must not touch state
    expect(gitAny.github.pulls.update.mock.calls[0][0]).not.toHaveProperty('state');
    expect(gitAny.github.pulls.create).not.toHaveBeenCalled();
    expect(result.number).toBe(12);
    expect(result.action).toBe('reopened');
    expect(gitAny.prWasReopened).toBe(false);
  });

  it('createOrUpdatePr reports the updated action for an existing open PR', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.prBranch = 'sync/repo/main';
    gitAny.baseBranch = 'main';
    gitAny.existingPr = { number: 7, html_url: 'https://github.com/test/repo/pull/7', body: 'old' };
    gitAny.prWasReopened = false;
    gitAny.github.pulls.update.mockResolvedValue({
      data: { number: 7, html_url: 'https://github.com/test/repo/pull/7', body: 'new' }
    });

    const result = await git.createOrUpdatePr('');

    expect(gitAny.github.pulls.create).not.toHaveBeenCalled();
    expect(result.number).toBe(7);
    expect(result.action).toBe('updated');
  });

  it('createOrUpdatePr creates a new PR when there is none to reuse', async () => {
    const git = new Git();
    execGitMock.mockResolvedValue('main');
    await git.initRepo(mockRepoInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.prBranch = 'sync/repo/main';
    gitAny.baseBranch = 'main';
    gitAny.existingPr = undefined;
    gitAny.github.pulls.create.mockResolvedValue({
      data: { number: 13, html_url: 'https://github.com/test/repo/pull/13', body: 'new' }
    });

    const result = await git.createOrUpdatePr('');

    expect(gitAny.github.pulls.create).toHaveBeenCalled();
    expect(result.number).toBe(13);
    expect(result.action).toBe('created');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';

// Hoist mocks to be available before module imports
const { execCmdMock, removeMock } = vi.hoisted(() => ({
  execCmdMock: vi.fn().mockResolvedValue(''),
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
  execCmd: execCmdMock,
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
      execCmdMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      // Working directory contains the unique name (with path separators)
      expect(git.workingDir).toContain('github.com');
      expect(git.workingDir).toContain('test');
      expect(git.workingDir).toContain('repo');
    });

    it('should call clone during init', async () => {
      execCmdMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      // Clone is called with the full command including path
      const cloneCall = execCmdMock.mock.calls.find((call) =>
        typeof call[0] === 'string' && call[0].includes('git clone')
      );
      expect(cloneCall).toBeDefined();
      expect(cloneCall?.[0]).toContain('git clone');
    });

    it('should set git identity during init', async () => {
      execCmdMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      expect(execCmdMock).toHaveBeenCalledWith(
        expect.stringContaining('git config --local user.name'),
        expect.any(String)
      );
    });
  });

  describe('createPrBranch', () => {
    beforeEach(async () => {
      execCmdMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should create branch with default naming', async () => {
      await git.createPrBranch();

      expect(execCmdMock).toHaveBeenCalledWith(
        expect.stringContaining('git switch'),
        expect.any(String)
      );
    });

    it('should append branch suffix when provided', async () => {
      await git.createPrBranch('custom-suffix');

      // Should include the suffix in the branch name
      expect(execCmdMock).toHaveBeenCalledWith(
        expect.stringMatching(/git switch.*custom-suffix/),
        expect.any(String)
      );
    });
  });

  describe('add', () => {
    beforeEach(async () => {
      execCmdMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should add file to staging', async () => {
      await git.add('test-file.txt');

      expect(execCmdMock).toHaveBeenCalledWith(
        'git add -f "test-file.txt"',
        expect.any(String)
      );
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      execCmdMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should remove file from repo', async () => {
      await git.remove('test-file.txt');

      expect(execCmdMock).toHaveBeenCalledWith(
        'git rm -f "test-file.txt"',
        expect.any(String)
      );
    });
  });

  describe('hasStagedChanges', () => {
    beforeEach(async () => {
      execCmdMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should return true when there are staged changes', async () => {
      execCmdMock.mockResolvedValueOnce('LICENSE\nREADME.md');

      const result = await git.hasStagedChanges();
      expect(result).toBe(true);

      expect(execCmdMock).toHaveBeenCalledWith(
        'git diff --cached --name-only',
        expect.any(String)
      );
    });

    it('should return false when there are no staged changes', async () => {
      execCmdMock.mockResolvedValueOnce('');

      const result = await git.hasStagedChanges();
      expect(result).toBe(false);
    });

    it('should return false when only unstaged changes exist', async () => {
      // git diff --cached --name-only returns empty when changes are unstaged
      execCmdMock.mockResolvedValueOnce('');

      const result = await git.hasStagedChanges();
      expect(result).toBe(false);
    });
  });

  describe('cleanupRepo', () => {
    beforeEach(async () => {
      execCmdMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should remove working directory', async () => {
      await git.cleanupRepo(mockRepoInfo);

      expect(removeMock).toHaveBeenCalledWith(git.workingDir);
    });
  });

  describe('branch operations', () => {
    beforeEach(async () => {
      execCmdMock.mockResolvedValue('main');
      await git.initRepo(mockRepoInfo);
    });

    it('should fetch all branches when creating PR branch with overwrite', async () => {
      await git.createPrBranch();

      expect(execCmdMock).toHaveBeenCalledWith(
        "git remote set-branches origin '*'",
        expect.any(String)
      );

      expect(execCmdMock).toHaveBeenCalledWith(
        'git fetch -v --depth=1',
        expect.any(String)
      );
    });
  });

  describe('clone', () => {
    it('should clone with branch option when branch is not default', async () => {
      execCmdMock.mockResolvedValue('main');

      await git.initRepo(mockRepoInfo);

      const cloneCall = execCmdMock.mock.calls.find((call) =>
        typeof call[0] === 'string' && call[0].includes('git clone')
      );
      expect(cloneCall?.[0]).toContain('--branch "main"');
    });

    it('should clone without branch option when branch is default', async () => {
      const defaultBranchRepo: RepoInfo = {
        ...mockRepoInfo,
        branch: 'default'
      };

      execCmdMock.mockResolvedValue('main');

      await git.initRepo(defaultBranchRepo);

      // Should not include --branch option
      const cloneCall = execCmdMock.mock.calls.find((call) =>
        typeof call[0] === 'string' && call[0].includes('git clone')
      );
      expect(cloneCall?.[0]).not.toContain('--branch');
    });
  });

  describe('getBaseBranch', () => {
    it('should get current branch name', async () => {
      execCmdMock.mockImplementation((cmd: string) => {
        if (cmd.includes('git rev-parse --abbrev-ref HEAD')) {
          return Promise.resolve('main');
        }
        return Promise.resolve('');
      });

      await git.initRepo(mockRepoInfo);

      expect(execCmdMock).toHaveBeenCalledWith(
        'git rev-parse --abbrev-ref HEAD',
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
      execCmdMock.mockResolvedValue('feature/test');

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

      const cloneCall = execCmdMock.mock.calls.find((call) =>
        typeof call[0] === 'string' && call[0].includes('git clone')
      );
      expect(cloneCall?.[0]).toContain('--branch "feature/test"');
    });
  });

  describe('working directory path', () => {
    it('should use unique name for working directory', async () => {
      const git = new Git();
      execCmdMock.mockResolvedValue('main');

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
      execCmdMock.mockResolvedValue('main');

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
      execCmdMock.mockResolvedValueOnce('abc123\ndef456');

      const commits = await (git as unknown as { getCommitsToPush: () => Promise<string[]> }).getCommitsToPush();

      // Verify it uses lastCommitSha (which is 'main' from mock) not baseBranch
      const logCall = execCmdMock.mock.calls.find((call) =>
        typeof call[0] === 'string' && call[0].includes('git log --format=%H --reverse')
      );
      expect(logCall).toBeDefined();
      expect(logCall?.[0]).toContain('main..HEAD');
      expect(commits).toEqual(['abc123', 'def456']);
    });

    it('should filter empty strings from git log output', async () => {
      const git = new Git();
      execCmdMock.mockResolvedValue('main');

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
      execCmdMock.mockResolvedValueOnce('');

      const commits = await (git as unknown as { getCommitsToPush: () => Promise<string[]> }).getCommitsToPush();
      expect(commits).toEqual([]);
    });
  });

  describe('getAllChangedFiles', () => {
    it('should return all files changed between base branch and HEAD', async () => {
      const git = new Git();
      execCmdMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      // Mock git diff --name-only output with all changed files
      execCmdMock.mockResolvedValueOnce('file-a.txt\nfile-b.txt\nfile-c.txt\nfile-d.txt\nfile-e.txt');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (git as any).getAllChangedFiles();

      expect(result).toContain('file-a.txt');
      expect(result).toContain('file-b.txt');
      expect(result).toContain('file-c.txt');
      expect(result).toContain('file-d.txt');
      expect(result).toContain('file-e.txt');
      expect(result).toContain('<details>');
      expect(result).toContain('Changed files');
    });

    it('should return empty string when no files changed', async () => {
      const git = new Git();
      execCmdMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      execCmdMock.mockResolvedValueOnce('');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (git as any).getAllChangedFiles();

      expect(result).toBe('');
    });

    it('should use git diff with three-dot notation against base branch', async () => {
      const git = new Git();
      execCmdMock.mockResolvedValue('main');

      await git.initRepo({
        url: 'https://github.com/test/repo',
        fullName: 'github.com/test/repo',
        uniqueName: 'github.com/test/repo@main',
        host: 'github.com',
        user: 'test',
        name: 'repo',
        branch: 'main'
      });

      execCmdMock.mockResolvedValueOnce('somefile.txt');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (git as any).getAllChangedFiles();

      const diffCall = execCmdMock.mock.calls.find((call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('git diff --name-only')
      );
      expect(diffCall).toBeDefined();
      expect(diffCall?.[0]).toContain('main...HEAD');
    });
  });

  describe('closed PR handling', () => {
    it('should detect closed unmerged PR and delete remote branch', async () => {
      const git = new Git();
      execCmdMock.mockResolvedValue('main');

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
      execCmdMock.mockResolvedValue('main');

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
      execCmdMock.mockResolvedValue('main');

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
      execCmdMock.mockResolvedValue('main');

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

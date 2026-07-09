import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';

// Hoisted, per-test controllable mocks
const { execGitMock, removeMock, compareCommitsMock, pullsListMock, updateRefMock, createRefMock } = vi.hoisted(() => ({
  execGitMock: vi.fn(),
  removeMock: vi.fn().mockResolvedValue(undefined),
  compareCommitsMock: vi.fn(),
  pullsListMock: vi.fn().mockResolvedValue({ data: [] }),
  updateRefMock: vi.fn().mockResolvedValue({ data: {} }),
  createRefMock: vi.fn().mockResolvedValue({ data: {} })
}));

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

vi.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    eventName: 'workflow_dispatch',
    payload: {}
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
            get: vi.fn(),
            compareCommits: compareCommitsMock
          },
          users: {
            getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'test', email: 'test@test.com' } })
          },
          pulls: {
            list: pullsListMock,
            listFiles: vi.fn().mockResolvedValue({ data: [] }),
            create: vi.fn().mockResolvedValue({ data: { number: 1, html_url: 'https://github.com/test/repo/pull/1' } }),
            update: vi.fn()
          },
          issues: {
            addLabels: vi.fn(),
            addAssignees: vi.fn()
          },
          git: {
            createRef: createRefMock,
            createTree: vi.fn(),
            createCommit: vi.fn(),
            updateRef: updateRefMock,
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

// REBASE enabled in config for this suite
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
    REBASE: true,
    SKIP_PR: false,
    PR_BODY: 'PR body',
    BRANCH_PREFIX: 'sync/',
    FORK: undefined
  }
}));

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

const mockRepoInfo: RepoInfo = {
  url: 'https://github.com/test/repo',
  fullName: 'github.com/test/repo',
  uniqueName: 'github.com/test/repo@main',
  host: 'github.com',
  user: 'test',
  name: 'repo',
  branch: 'main'
};

// Base branch is 'main'; optionally pretend the remote PR branch already exists.
function setupExecGit({ remoteBranchExists = true }: { remoteBranchExists?: boolean } = {}) {
  execGitMock.mockImplementation((args: unknown) => {
    const cmd = Array.isArray(args) ? args.join(' ') : String(args);
    if (cmd === 'rev-parse --abbrev-ref HEAD') return Promise.resolve('main');
    if (cmd.startsWith('rev-parse --verify origin/')) {
      return remoteBranchExists ? Promise.resolve('oldsha123') : Promise.reject(new Error('not found'));
    }
    if (cmd === 'rev-parse HEAD') return Promise.resolve('basesha456');
    return Promise.resolve('');
  });
}

function findCall(predicate: (args: string[]) => boolean) {
  return execGitMock.mock.calls.find((c) => Array.isArray(c[0]) && predicate(c[0] as string[]));
}

describe('git.ts - REBASE mode', () => {
  let git: Git;

  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue(undefined);
    pullsListMock.mockResolvedValue({ data: [] });
    updateRefMock.mockResolvedValue({ data: {} });
    createRefMock.mockResolvedValue({ data: {} });
    git = new Git();
  });

  it('rebuilds the PR branch on the latest base and force-pushes when behind base', async () => {
    setupExecGit({ remoteBranchExists: true });
    compareCommitsMock.mockResolvedValue({ data: { ahead_by: 2, behind_by: 0, status: 'ahead' } });

    await git.initRepo(mockRepoInfo);
    await git.createPrBranch();

    // Branch is force-recreated from the freshly cloned base tip
    expect(findCall((a) => a[0] === 'switch' && a[1] === '-C')).toBeDefined();

    await git.push();

    const forcePush = findCall((a) => a[0] === 'push' && a.some((arg) => arg.startsWith('--force-with-lease=')));
    expect(forcePush).toBeDefined();
    expect(forcePush?.[0]).toContain('--force-with-lease=refs/heads/sync/main:oldsha123');
    expect((forcePush?.[0] as string[]).some((x) => x.startsWith('HEAD:refs/heads/'))).toBe(true);
  });

  it('reuses the existing branch without forcing when already up to date with base', async () => {
    setupExecGit({ remoteBranchExists: true });
    compareCommitsMock.mockResolvedValue({ data: { ahead_by: 0, behind_by: 0, status: 'identical' } });

    await git.initRepo(mockRepoInfo);
    await git.createPrBranch();

    // Normal reuse: track the existing remote branch, never force-create it
    expect(findCall((a) => a[0] === 'switch' && a[1] === '-C')).toBeUndefined();
    expect(findCall((a) => a[0] === 'switch' && a.includes('--track') && a.includes('origin/sync/main'))).toBeDefined();

    await git.push();

    expect(findCall((a) => a[0] === 'push' && a.some((arg) => arg.startsWith('--force')))).toBeUndefined();
  });

  it('does not rebase on the first run when no remote branch exists', async () => {
    setupExecGit({ remoteBranchExists: false });

    await git.initRepo(mockRepoInfo);
    await git.createPrBranch();

    // No remote branch -> the compare API is never consulted and nothing is forced
    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(findCall((a) => a[0] === 'switch' && a[1] === '-C')).toBeUndefined();

    await git.push();

    expect(findCall((a) => a[0] === 'push' && a.some((arg) => arg.startsWith('--force')))).toBeUndefined();
  });
});

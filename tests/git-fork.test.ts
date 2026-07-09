import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const { execGitMock, pullsListMock } = vi.hoisted(() => ({
  execGitMock: vi.fn(),
  pullsListMock: vi.fn()
}));

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

vi.mock('@actions/github', () => ({
  context: { eventName: 'workflow_dispatch', payload: {} }
}));

vi.mock('@actions/github/lib/utils', () => ({
  GitHub: {
    plugin: vi.fn(() => {
      return class MockOctokit {
        rest = {
          repos: {
            createFork: vi.fn(),
            compareCommits: vi.fn()
          },
          users: {
            getAuthenticated: vi.fn()
          },
          pulls: {
            list: pullsListMock,
            update: vi.fn()
          },
          issues: {},
          git: {}
        };
      };
    })
  },
  getOctokitOptions: vi.fn(() => ({}))
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
    COMMIT_PREFIX: '',
    GITHUB_REPOSITORY: 'source/repo',
    OVERWRITE_EXISTING_PR: true,
    REBASE: false,
    SKIP_PR: false,
    PR_BODY: '',
    BRANCH_PREFIX: 'sync/',
    FORK: 'sync-bot'
  }
}));

vi.mock('../src/helpers.js', () => ({
  dedent: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, value, index) => result + value + (values[index] ?? ''), '')
  ),
  execGit: execGitMock,
  execGitBuffer: vi.fn(),
  remove: vi.fn()
}));

import Git from '../src/git.js';
import type { RepoInfo } from '../src/types.js';

const repo: RepoInfo = {
  url: 'https://github.com/target/repo',
  fullName: 'github.com/target/repo',
  uniqueName: 'github.com/target/repo@main',
  host: 'github.com',
  user: 'target',
  name: 'repo',
  branch: 'main'
};

describe('git.ts - fork workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pullsListMock.mockResolvedValue({
      data: [{ number: 7, html_url: 'https://github.com/target/repo/pull/7', body: null }]
    });
    execGitMock.mockImplementation((args: string[]) => {
      const command = args.join(' ');
      if (command === 'rev-list -n 1 --all') return Promise.resolve('base-sha');
      if (command === 'rev-parse --abbrev-ref HEAD') return Promise.resolve('main');
      if (command === 'rev-parse --verify fork/sync/main') return Promise.resolve('fork-head');
      if (command === 'rev-parse HEAD') return Promise.resolve('base-sha');
      return Promise.resolve('');
    });
  });

  it('should discover, check, and push an existing branch through the fork remote', async () => {
    const git = new Git();

    await git.initRepo(repo);
    await git.createPrBranch();
    await git.push();

    expect(execGitMock).toHaveBeenCalledWith(['remote', 'set-branches', 'fork', '*'], git.workingDir);
    expect(execGitMock).toHaveBeenCalledWith(['fetch', '-v', '--depth=1', 'fork'], git.workingDir);
    expect(execGitMock).toHaveBeenCalledWith(['rev-parse', '--verify', 'fork/sync/main'], git.workingDir);
    expect(execGitMock).toHaveBeenCalledWith(
      ['switch', '--track', '-c', 'sync/main', 'fork/sync/main'],
      git.workingDir
    );
    expect(execGitMock).toHaveBeenCalledWith(['fetch', 'fork', 'sync/main'], git.workingDir);
    expect(execGitMock).toHaveBeenCalledWith(['push', '-u', 'fork', 'sync/main'], git.workingDir);
    expect(pullsListMock).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'open', head: 'sync-bot:sync/main' })
    );
  });
});
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const mocks = vi.hoisted(() => ({
  execGit: vi.fn(),
  updateRef: vi.fn()
}));

vi.mock('@actions/core', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@actions/github', () => ({ context: { eventName: 'workflow_dispatch', payload: {} } }));
vi.mock('@actions/github/lib/utils', () => ({
  GitHub: {
    plugin: vi.fn(() => class MockOctokit {
      rest = {
        repos: {},
        users: { getAuthenticated: vi.fn() },
        pulls: { update: vi.fn() },
        issues: {},
        git: { updateRef: mocks.updateRef }
      };
    })
  },
  getOctokitOptions: vi.fn(() => ({}))
}));
vi.mock('@octokit/plugin-throttling', () => ({ throttling: vi.fn() }));
vi.mock('../src/config.js', () => ({
  default: {
    GITHUB_TOKEN: 'installation-token',
    GITHUB_SERVER_URL: 'https://github.com',
    IS_INSTALLATION_TOKEN: true,
    IS_FINE_GRAINED: false,
    GIT_USERNAME: undefined,
    GIT_EMAIL: undefined,
    TMP_DIR: os.tmpdir(),
    COMMIT_BODY: '',
    COMMIT_PREFIX: '',
    GITHUB_REPOSITORY: 'owner/repo',
    OVERWRITE_EXISTING_PR: true,
    SKIP_PR: true,
    PR_BODY: '',
    BRANCH_PREFIX: 'sync/',
    FORK: undefined,
    REBASE: false
  }
}));
vi.mock('../src/helpers.js', () => ({
  dedent: vi.fn(),
  execGit: mocks.execGit,
  execGitBuffer: vi.fn(),
  remove: vi.fn()
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

interface GitState {
  baseBranch: string;
  lastCommitSha: string;
  forceUpdateBranch: boolean;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execGit.mockImplementation((args: string[]) => {
    if (args[0] === 'rev-list') return Promise.resolve('base-sha');
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return Promise.resolve('main');
    if (args.join(' ') === 'rev-parse HEAD') return Promise.resolve('base-sha');
    return Promise.resolve('');
  });
  mocks.updateRef.mockResolvedValue({ data: {} });
});

describe('git.ts - installation token', () => {
  it('uses verified commits and updates the base branch directly', async () => {
    const git = new Git();
    await git.initRepo(repo);
    const state = git as unknown as GitState;
    state.baseBranch = 'main';
    state.lastCommitSha = 'base-sha';
    state.forceUpdateBranch = true;
    vi.spyOn(git, 'getCommitsToPush').mockResolvedValue([]);

    await git.push();

    expect(mocks.updateRef).toHaveBeenCalledWith({
      owner: 'test',
      repo: 'repo',
      ref: 'heads/main',
      sha: 'base-sha',
      force: true
    });
    expect(mocks.execGit.mock.calls.find((call) => call[0][0] === 'clone')?.[0]).toContain(
      'https://x-access-token:installation-token@github.com/test/repo.git'
    );
  });
});
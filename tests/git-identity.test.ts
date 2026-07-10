import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const mocks = vi.hoisted(() => ({
  execGit: vi.fn(),
  getAuthenticated: vi.fn()
}));

vi.mock('@actions/core', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@actions/github', () => ({ context: { eventName: 'workflow_dispatch', payload: {} } }));
vi.mock('@actions/github/lib/utils', () => ({
  GitHub: {
    plugin: vi.fn(() => class MockOctokit {
      rest = {
        repos: {},
        users: { getAuthenticated: mocks.getAuthenticated },
        pulls: {},
        issues: {},
        git: {}
      };
    })
  },
  getOctokitOptions: vi.fn(() => ({}))
}));
vi.mock('@octokit/plugin-throttling', () => ({ throttling: vi.fn() }));
vi.mock('../src/config.js', () => ({
  default: {
    GITHUB_TOKEN: 'test-token',
    GITHUB_SERVER_URL: 'https://github.com',
    IS_INSTALLATION_TOKEN: false,
    IS_FINE_GRAINED: false,
    GIT_USERNAME: undefined,
    GIT_EMAIL: undefined,
    TMP_DIR: os.tmpdir(),
    COMMIT_BODY: '',
    COMMIT_PREFIX: '',
    GITHUB_REPOSITORY: 'owner/repo',
    OVERWRITE_EXISTING_PR: true,
    SKIP_PR: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execGit.mockImplementation((args: string[]) => {
    if (args[0] === 'rev-list') return Promise.resolve('base-sha');
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return Promise.resolve('main');
    if (args.join(' ') === 'rev-parse HEAD') return Promise.resolve('base-sha');
    return Promise.resolve('');
  });
});

describe('git.ts - authenticated identity', () => {
  it('uses the authenticated login and email when identity is not configured', async () => {
    mocks.getAuthenticated.mockResolvedValue({ data: { login: 'octocat', email: 'octocat@example.com' } });
    const git = new Git();

    await git.initRepo(repo);

    expect(mocks.execGit).toHaveBeenCalledWith(['config', '--local', 'user.name', 'octocat'], git.workingDir);
    expect(mocks.execGit).toHaveBeenCalledWith(['config', '--local', 'user.email', 'octocat@example.com'], git.workingDir);
  });

  it('stringifies a missing authenticated email', async () => {
    mocks.getAuthenticated.mockResolvedValue({ data: { login: 'octocat', email: null } });
    const git = new Git();

    await git.initRepo(repo);

    expect(mocks.execGit).toHaveBeenCalledWith(['config', '--local', 'user.email', 'undefined'], git.workingDir);
  });
});

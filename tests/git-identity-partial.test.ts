import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

// Same suite as git-identity.test.ts, but with GIT_EMAIL configured and
// GIT_USERNAME left unset. `git.ts` destructures its config at import time, so a
// different combination needs its own module registry - matching the pattern
// already used by git-fork/git-rebase/git-no-overwrite.
const mocks = vi.hoisted(() => ({
  execGit: vi.fn(),
  getAuthenticated: vi.fn()
}));

vi.mock('@actions/core', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@actions/github', () => ({ context: { eventName: 'workflow_dispatch', payload: {} } }));
vi.mock('@actions/github/lib/utils', () => ({
  GitHub: {
    plugin: vi.fn(
      () =>
        class MockOctokit {
          rest = {
            repos: {},
            users: { getAuthenticated: mocks.getAuthenticated },
            pulls: {},
            issues: {},
            git: {}
          };
        }
    )
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
    GIT_EMAIL: 'configured@example.com',
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

describe('git.ts - partially configured identity', () => {
  it('keeps the configured email and resolves only the missing username', async () => {
    mocks.getAuthenticated.mockResolvedValue({ data: { login: 'octocat', email: 'ignored@example.com', id: 1 } });
    const git = new Git();

    await git.initRepo(repo);

    // Regression guard: GIT_EMAIL alone used to skip the lookup entirely, which
    // configured the literal string "undefined" as user.name.
    expect(mocks.execGit).toHaveBeenCalledWith(
      [
        'config',
        '--local',
        'user.name',
        'octocat'
      ],
      git.workingDir
    );
    expect(mocks.execGit).toHaveBeenCalledWith(
      [
        'config',
        '--local',
        'user.email',
        'configured@example.com'
      ],
      git.workingDir
    );
    expect(mocks.execGit).not.toHaveBeenCalledWith(
      [
        'config',
        '--local',
        'user.name',
        'undefined'
      ],
      git.workingDir
    );
  });
});

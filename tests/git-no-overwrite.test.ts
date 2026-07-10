import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const mocks = vi.hoisted(() => ({ execGit: vi.fn() }));

vi.mock('@actions/core', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@actions/github', () => ({ context: { eventName: 'workflow_dispatch', payload: {} } }));
vi.mock('@actions/github/lib/utils', () => ({
  GitHub: {
    plugin: vi.fn(() => class MockOctokit {
      rest = { repos: {}, users: {}, pulls: {}, issues: {}, git: {} };
    })
  },
  getOctokitOptions: vi.fn(() => ({}))
}));
vi.mock('@octokit/plugin-throttling', () => ({ throttling: vi.fn() }));
vi.mock('../src/config.js', () => ({
  default: {
    GITHUB_TOKEN: 'fine-token',
    GITHUB_SERVER_URL: 'https://github.com',
    IS_INSTALLATION_TOKEN: false,
    IS_FINE_GRAINED: true,
    GIT_USERNAME: 'sync-user',
    GIT_EMAIL: 'sync@example.com',
    TMP_DIR: os.tmpdir(),
    COMMIT_BODY: 'Commit details',
    COMMIT_PREFIX: 'sync:',
    GITHUB_REPOSITORY: '',
    OVERWRITE_EXISTING_PR: false,
    SKIP_PR: false,
    PR_BODY: '',
    BRANCH_PREFIX: 'sync/SOURCE_REPO_NAME',
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
  branch: '.main'
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

describe('git.ts - no-overwrite mode', () => {
  it('creates a timestamped branch and appends the configured commit body', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const git = new Git();

    try {
      await git.initRepo(repo);
      await git.createPrBranch('suffix');
      await git.commit();
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.execGit).toHaveBeenCalledWith(['switch', '-c', 'sync/main-suffix-1700000000'], git.workingDir);
    expect(mocks.execGit).toHaveBeenCalledWith(
      ['commit', '-m', 'sync: synced file(s) with \n\nCommit details'],
      git.workingDir
    );
    expect(mocks.execGit.mock.calls.find((call) => call[0][0] === 'clone')?.[0]).toContain(
      'https://oauth:fine-token@github.com/test/repo.git'
    );
  });
});

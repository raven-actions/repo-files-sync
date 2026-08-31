import { beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the orchestration in src/run.ts, which used to live in src/index.ts
// and was excluded from coverage entirely because importing it started a sync.
// This file covers the default configuration; run-dry-run and run-skip-pr cover
// the option combinations that src/run.ts destructures at import time.
const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  pathIsDirectory: vi.fn(),
  resolvePathWithinRoot: vi.fn(),
  isPathWithinRoot: vi.fn(),
  copy: vi.fn(),
  remove: vi.fn(),
  configureTemplateSandbox: vi.fn(),
  configureTemplateAutoescape: vi.fn(),
  parseConfig: vi.fn(),
  gitFactory: vi.fn()
}));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  default: { existsSync: mocks.existsSync }
}));

vi.mock('../src/git.js', () => ({
  // A named function expression rather than an arrow, so `new Git()` works.
  // Returning an object from a constructor makes `new` yield that object.
  default: vi.fn(function GitStub() {
    return mocks.gitFactory();
  })
}));

vi.mock('../src/helpers.js', () => ({
  forEach: async (array: unknown[], callback: (item: unknown, index: number, array: unknown[]) => Promise<void>) => {
    for (let index = 0; index < array.length; index++) {
      const item = array[index];
      if (item !== undefined) await callback(item, index, array);
    }
  },
  dedent: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
    typeof strings === 'string' ? strings : (
      strings.reduce((acc, part, index) => acc + part + (values[index] ?? ''), '')
    ),
  addTrailingSlash: (value: string) => (value.endsWith('/') ? value : `${value}/`),
  pathIsDirectory: mocks.pathIsDirectory,
  resolvePathWithinRoot: mocks.resolvePathWithinRoot,
  isPathWithinRoot: mocks.isPathWithinRoot,
  copy: mocks.copy,
  remove: mocks.remove,
  arrayEquals: (a: unknown[], b: unknown[]) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]),
  configureTemplateSandbox: mocks.configureTemplateSandbox,
  configureTemplateAutoescape: mocks.configureTemplateAutoescape
}));

vi.mock('../src/config.js', () => ({
  parseConfig: mocks.parseConfig,
  default: {
    COMMIT_EACH_FILE: true,
    COMMIT_PREFIX: 'PREFIX',
    PR_LABELS: ['sync'],
    PR_TITLE: '',
    ASSIGNEES: ['assignee1'],
    DRY_RUN: false,
    TMP_DIR: 'tmp-test',
    SKIP_CLEANUP: false,
    OVERWRITE_EXISTING_PR: true,
    SKIP_PR: false,
    ORIGINAL_MESSAGE: false,
    COMMIT_AS_PR_TITLE: false,
    FORK: undefined,
    REVIEWERS: ['global-reviewer'],
    TEAM_REVIEWERS: ['team1'],
    TEMPLATE_SANDBOX: true,
    TEMPLATE_AUTOESCAPE: true
  }
}));

import * as core from '@actions/core';
import { run, processFile, processRepo, excludedWorkingDirs } from '../src/run.js';
import { createGit, makeFile, makeRepoConfig, type GitMock } from './fixtures/run-fixtures.js';
import type { ModifiedFile } from '../src/types.js';

let git: GitMock;

beforeEach(() => {
  vi.clearAllMocks();
  git = createGit();
  mocks.gitFactory.mockReturnValue(git);
  mocks.resolvePathWithinRoot.mockImplementation((root: string, input: string) => Promise.resolve(`${root}/${input}`));
  mocks.isPathWithinRoot.mockReturnValue(false);
  mocks.pathIsDirectory.mockResolvedValue(false);
  mocks.existsSync.mockReturnValue(true);
  mocks.parseConfig.mockResolvedValue([makeRepoConfig()]);
});

describe('run.ts - excludedWorkingDirs', () => {
  it('returns the working directory only when it falls inside the source', () => {
    mocks.isPathWithinRoot.mockReturnValue(true);
    expect(excludedWorkingDirs('/repo')).toHaveLength(1);

    mocks.isPathWithinRoot.mockReturnValue(false);
    expect(excludedWorkingDirs('/repo')).toEqual([]);
  });
});

describe('run.ts - processFile', () => {
  it('warns and skips when the source is missing and deleteOrphaned is off', async () => {
    mocks.existsSync.mockReturnValue(false);
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile(), modified, makeRepoConfig());

    expect(core.warning).toHaveBeenCalledWith('Source src/file.txt not found');
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(modified).toHaveLength(0);
  });

  it('removes an orphaned destination when the source is gone', async () => {
    // Source missing, destination present.
    mocks.existsSync.mockImplementation((target: string) => target.includes('dest/file.txt'));
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile({ deleteOrphaned: true }), modified, makeRepoConfig());

    expect(git.remove).toHaveBeenCalledWith('dest/file.txt');
    expect(modified).toHaveLength(1);
  });

  it('does nothing when both source and destination are gone', async () => {
    mocks.existsSync.mockReturnValue(false);
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile({ deleteOrphaned: true }), modified, makeRepoConfig());

    expect(git.remove).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing destination when replace is false', async () => {
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile({ replace: false }), modified, makeRepoConfig());

    expect(core.warning).toHaveBeenCalledWith(
      "File(s) already exist(s) in destination and 'replace' option is set to false"
    );
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it('copies a directory source with trailing slashes and stages it', async () => {
    mocks.pathIsDirectory.mockResolvedValue(true);
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile(), modified, makeRepoConfig());

    expect(core.info).toHaveBeenCalledWith('Source is directory');
    const [
      source,
      dest,
      isDirectory
    ] = mocks.copy.mock.calls[0] as [
      string,
      string,
      boolean
    ];
    expect(source.endsWith('/')).toBe(true);
    expect(dest.endsWith('/')).toBe(true);
    expect(isDirectory).toBe(true);
    expect(git.add).toHaveBeenCalledWith('dest/file.txt');
  });

  it('skips the commit when nothing was staged', async () => {
    git.hasStagedChanges.mockResolvedValue(false);
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile(), modified, makeRepoConfig());

    expect(git.commit).not.toHaveBeenCalled();
    expect(modified).toHaveLength(0);
  });

  it('records a "synced" commit when the destination already existed', async () => {
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile(), modified, makeRepoConfig());

    expect(git.commit).toHaveBeenCalledWith("PREFIX synced local 'dest/file.txt' with remote 'src/file.txt'");
    expect(modified[0]?.message).toContain('synced local');
  });

  it('records a "created" commit when the destination is new', async () => {
    // Source exists, destination does not.
    mocks.existsSync.mockImplementation((target: string) => target.includes('src/file.txt'));
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile(), modified, makeRepoConfig());

    expect(git.commit).toHaveBeenCalledWith("PREFIX created local 'dest/file.txt' from remote 'src/file.txt'");
    expect(modified[0]?.message).toContain('created local');
  });
});

describe('run.ts - processRepo', () => {
  it('skips a repository whose default branch has no commits', async () => {
    git.isEmptyRepo = true;

    const result = await processRepo(git as never, makeRepoConfig());

    expect(result).toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith('Skipping github.com/test/repo: default branch has no commits yet');
    expect(git.createPrBranch).not.toHaveBeenCalled();
    expect(git.cleanupRepo).toHaveBeenCalled();
  });

  it('warns on an existing pull request and returns its url after pushing', async () => {
    git.findExistingPr.mockResolvedValue({ number: 3, html_url: 'https://example.com/pull/3', body: null });

    const result = await processRepo(git as never, makeRepoConfig());

    expect(git.setPrWarning).toHaveBeenCalled();
    expect(git.push).toHaveBeenCalled();
    expect(result).toBe('https://github.com/test/repo/pull/7');
    expect(core.notice).toHaveBeenCalledWith('Pull Request #7 created: https://github.com/test/repo/pull/7');
  });

  it('adds labels, assignees, reviewers and team reviewers to the pull request', async () => {
    await processRepo(git as never, makeRepoConfig());

    expect(git.addPrLabels).toHaveBeenCalledWith(['sync']);
    expect(git.addPrAssignees).toHaveBeenCalledWith(['assignee1']);
    expect(git.addPrReviewers).toHaveBeenCalledWith(['global-reviewer']);
    expect(git.addPrTeamReviewers).toHaveBeenCalledWith(['team1']);
  });

  it('prefers group-level reviewers over the global REVIEWERS input', async () => {
    await processRepo(git as never, makeRepoConfig({ reviewers: ['group-reviewer'] }));

    expect(git.addPrReviewers).toHaveBeenCalledWith(['group-reviewer']);
  });

  it('reports no changes and clears a stale pull request warning', async () => {
    git.hasStagedChanges.mockResolvedValue(false);
    git.findExistingPr.mockResolvedValue({ number: 3, html_url: 'https://example.com/pull/3', body: null });

    const result = await processRepo(git as never, makeRepoConfig());

    expect(core.info).toHaveBeenCalledWith('File(s) already up to date');
    expect(git.removePrWarning).toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('labels the log group with the branch and suffix', async () => {
    await processRepo(git as never, makeRepoConfig({ branchSuffix: 'docs' }));

    expect(core.startGroup).toHaveBeenCalledWith('test/repo@main (suffix: docs)');
  });

  it('fails the run but still cleans up when a repository throws', async () => {
    git.initRepo.mockRejectedValue(new Error('clone exploded'));

    const result = await processRepo(git as never, makeRepoConfig());

    expect(core.setFailed).toHaveBeenCalledWith('clone exploded');
    expect(git.cleanupRepo).toHaveBeenCalled();
    expect(core.endGroup).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe('run.ts - run', () => {
  it('configures templating, syncs every repo and publishes the pull request urls', async () => {
    await run();

    expect(mocks.configureTemplateSandbox).toHaveBeenCalledWith(true);
    expect(mocks.configureTemplateAutoescape).toHaveBeenCalledWith(true);
    expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('TEMPLATE_SANDBOX is disabled'));
    expect(core.setOutput).toHaveBeenCalledWith('pull_request_urls', ['https://github.com/test/repo/pull/7']);
    expect(mocks.remove).toHaveBeenCalledWith('tmp-test');
    expect(core.info).toHaveBeenCalledWith('Cleanup complete');
  });

  it('does not set an output when no pull request was created', async () => {
    git.hasStagedChanges.mockResolvedValue(false);

    await run();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith('tmp-test');
  });

  it('processes every configured repository', async () => {
    mocks.parseConfig.mockResolvedValue([
      makeRepoConfig(),
      makeRepoConfig({ branchSuffix: 'docs' })
    ]);

    await run();

    expect(git.initRepo).toHaveBeenCalledTimes(2);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// src/run.ts with FORK set, plus the ORIGINAL_MESSAGE / COMMIT_AS_PR_TITLE and
// OVERWRITE_EXISTING_PR=false branches, which the default suite cannot reach
// because run.ts destructures its config at import time.
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

vi.mock('fs', () => ({ existsSync: mocks.existsSync, default: { existsSync: mocks.existsSync } }));

vi.mock('../src/git.js', () => ({
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
    OVERWRITE_EXISTING_PR: false,
    SKIP_PR: false,
    ORIGINAL_MESSAGE: true,
    COMMIT_AS_PR_TITLE: true,
    FORK: 'sync-bot',
    REVIEWERS: ['global-reviewer'],
    TEAM_REVIEWERS: ['team1'],
    TEMPLATE_SANDBOX: false,
    TEMPLATE_AUTOESCAPE: false
  }
}));

import * as core from '@actions/core';
import { run, processRepo } from '../src/run.js';
import { createGit, makeRepoConfig, type GitMock } from './fixtures/run-fixtures.js';

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

describe('run.ts - fork workflow', () => {
  it('does not attach labels, assignees or reviewers when pushing through a fork', async () => {
    await processRepo(git as never, makeRepoConfig());

    // These all require write access to the target repo, which the fork
    // workflow deliberately does not have.
    expect(git.addPrLabels).not.toHaveBeenCalled();
    expect(git.addPrAssignees).not.toHaveBeenCalled();
    expect(git.addPrReviewers).not.toHaveBeenCalled();
    expect(git.addPrTeamReviewers).not.toHaveBeenCalled();
  });

  it('never looks for an existing PR when OVERWRITE_EXISTING_PR is disabled', async () => {
    await processRepo(git as never, makeRepoConfig());

    expect(git.findExistingPr).not.toHaveBeenCalled();
    expect(git.setPrWarning).not.toHaveBeenCalled();
  });

  it('reuses the original commit message and promotes its subject to the PR title', async () => {
    git.isOneCommitPush.mockReturnValue(true);
    git.getChangesFromLastCommit.mockResolvedValue(['same-diff']);
    git.changes.mockResolvedValue(['same-diff']);
    // Staged for the per-file commit, then clean so exactly one entry is recorded.
    git.hasStagedChanges.mockResolvedValueOnce(true).mockResolvedValue(false);

    await processRepo(git as never, makeRepoConfig());

    expect(git.commit).toHaveBeenCalledWith('feat: original subject\n\nbody');
    expect(git.createOrUpdatePr).toHaveBeenCalledWith(expect.any(String), 'feat: original subject');
  });

  it('reuses the original message for the combined commit when files remain staged', async () => {
    git.isOneCommitPush.mockReturnValue(true);
    git.getChangesFromLastCommit.mockResolvedValue(['same-diff']);
    git.changes.mockResolvedValue(['same-diff']);
    // Still staged after the per-file commit, so processRepo re-validates every
    // file before reusing the original message for the combined commit.
    git.hasStagedChanges.mockResolvedValue(true);

    await processRepo(git as never, makeRepoConfig());

    expect(git.commit).toHaveBeenLastCalledWith('feat: original subject\n\nbody');
    // Two entries were recorded, so the commit subject is not promoted to the title.
    expect(git.createOrUpdatePr).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('warns on every run while the template sandbox is disabled', async () => {
    await run();

    expect(mocks.configureTemplateSandbox).toHaveBeenCalledWith(false);
    expect(mocks.configureTemplateAutoescape).toHaveBeenCalledWith(false);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('TEMPLATE_SANDBOX is disabled'));
  });
});

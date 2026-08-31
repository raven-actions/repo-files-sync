import { beforeEach, describe, expect, it, vi } from 'vitest';

// src/run.ts with SKIP_PR (push straight to the base branch), COMMIT_EACH_FILE
// disabled (one combined commit) and SKIP_CLEANUP enabled.
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
    COMMIT_EACH_FILE: false,
    COMMIT_PREFIX: 'PREFIX',
    PR_LABELS: ['sync'],
    PR_TITLE: '',
    ASSIGNEES: ['assignee1'],
    DRY_RUN: false,
    TMP_DIR: 'tmp-test',
    SKIP_CLEANUP: true,
    OVERWRITE_EXISTING_PR: true,
    SKIP_PR: true,
    ORIGINAL_MESSAGE: false,
    COMMIT_AS_PR_TITLE: false,
    FORK: undefined,
    REVIEWERS: undefined,
    TEAM_REVIEWERS: undefined,
    TEMPLATE_SANDBOX: true,
    TEMPLATE_AUTOESCAPE: true
  }
}));

import * as core from '@actions/core';
import { run, processFile, processRepo } from '../src/run.js';
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

describe('run.ts - SKIP_PR and COMMIT_EACH_FILE disabled', () => {
  it('stages without committing when files are not committed individually', async () => {
    const modified: ModifiedFile[] = [];

    await processFile(git as never, makeFile(), modified, makeRepoConfig());

    expect(git.add).toHaveBeenCalledWith('dest/file.txt');
    expect(git.commit).not.toHaveBeenCalled();
    expect(modified).toHaveLength(0);
  });

  it('pushes straight to the base branch without creating a branch or pull request', async () => {
    const result = await processRepo(git as never, makeRepoConfig());

    expect(git.createPrBranch).not.toHaveBeenCalled();
    expect(git.findExistingPr).not.toHaveBeenCalled();
    expect(git.createOrUpdatePr).not.toHaveBeenCalled();
    expect(git.push).toHaveBeenCalled();
    // A single combined commit covers everything staged during processFile.
    expect(git.commit).toHaveBeenCalledWith(undefined);
    expect(result).toBeUndefined();
  });

  it('keeps the working directory when cleanup is skipped', async () => {
    await run();

    expect(git.cleanupRepo).toHaveBeenCalledWith(expect.anything(), false);
    expect(core.info).toHaveBeenCalledWith('Skipping cleanup');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// src/run.ts in DRY_RUN mode: the sync is performed locally but nothing is
// committed, pushed, or reflected on an existing pull request.
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
    PR_LABELS: undefined,
    PR_TITLE: 'Custom title',
    ASSIGNEES: undefined,
    DRY_RUN: true,
    TMP_DIR: 'tmp-test',
    SKIP_CLEANUP: false,
    OVERWRITE_EXISTING_PR: true,
    SKIP_PR: false,
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

describe('run.ts - dry run', () => {
  it('reports the git status and pushes nothing', async () => {
    const result = await processRepo(git as never, makeRepoConfig());

    expect(core.warning).toHaveBeenCalledWith('Dry run, no changes will be pushed');
    expect(git.status).toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
    expect(git.createOrUpdatePr).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('leaves an existing pull request untouched', async () => {
    git.findExistingPr.mockResolvedValue({ number: 3, html_url: 'https://example.com/pull/3', body: null });

    await processRepo(git as never, makeRepoConfig());

    // The resync banner would otherwise be written to a PR that is not updated.
    expect(git.setPrWarning).not.toHaveBeenCalled();
    expect(git.removePrWarning).not.toHaveBeenCalled();
  });

  it('still cleans up the temporary directory', async () => {
    await run();

    expect(core.setOutput).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledWith('tmp-test');
  });
});

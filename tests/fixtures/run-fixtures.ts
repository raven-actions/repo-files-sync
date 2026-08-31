import { vi } from 'vitest';

import type { FileConfig, RepoConfig } from '../../src/types.js';

// Shared fixtures for the src/run.ts suites. src/run.ts destructures its config
// at import time, so each option combination needs its own module registry (and
// therefore its own test file); only these fixtures can be shared.

export function createGit() {
  return {
    workingDir: 'work-dir',
    isEmptyRepo: false,
    initRepo: vi.fn(),
    createPrBranch: vi.fn(),
    findExistingPr: vi.fn(),
    setPrWarning: vi.fn(),
    removePrWarning: vi.fn(),
    remove: vi.fn(),
    add: vi.fn(),
    hasStagedChanges: vi.fn().mockResolvedValue(true),
    isOneCommitPush: vi.fn().mockReturnValue(false),
    getChangesFromLastCommit: vi.fn().mockResolvedValue([]),
    changes: vi.fn().mockResolvedValue([]),
    originalCommitMessage: vi.fn().mockReturnValue('feat: original subject\n\nbody'),
    commit: vi.fn(),
    status: vi.fn().mockResolvedValue('status output'),
    push: vi.fn(),
    createOrUpdatePr: vi.fn().mockResolvedValue({
      number: 7,
      html_url: 'https://github.com/test/repo/pull/7',
      body: null,
      action: 'created'
    }),
    addPrLabels: vi.fn(),
    addPrAssignees: vi.fn(),
    addPrReviewers: vi.fn(),
    addPrTeamReviewers: vi.fn(),
    cleanupRepo: vi.fn()
  };
}

export type GitMock = ReturnType<typeof createGit>;

export function makeFile(overrides: Partial<FileConfig> = {}): FileConfig {
  return {
    source: 'src/file.txt',
    dest: 'dest/file.txt',
    template: false,
    replace: true,
    deleteOrphaned: false,
    exclude: undefined,
    include: undefined,
    ...overrides
  };
}

export function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repo: {
      url: 'https://github.com/test/repo',
      fullName: 'github.com/test/repo',
      uniqueName: 'github.com/test/repo@main',
      host: 'github.com',
      user: 'test',
      name: 'repo',
      branch: 'main'
    },
    files: [makeFile()],
    branchSuffix: '',
    ...overrides
  };
}

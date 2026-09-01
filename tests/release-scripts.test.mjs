import { beforeEach, describe, expect, it, vi } from 'vitest';

// The four release scripts run in the release pipeline with `contents: write`,
// so a bug there can corrupt tags, branches or published releases. They had no
// tests at all; these cover the branch/ref races, idempotent reruns and error
// handling that are hard to exercise safely in a real release.
//
// Written in .mjs to match the scripts themselves, which keeps them out of the
// TypeScript project (see vitest.config.ts).

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn()
}));

vi.mock('node:fs', () => ({
  default: fsMocks,
  ...fsMocks
}));

const { default: createReleaseBranch } = await import('../.github/scripts/release-branch-create.mjs');
const { default: verifyOrphanReleaseBranch } = await import('../.github/scripts/release-branch-assert-orphan.mjs');
const { default: createReleasePr } = await import('../.github/scripts/release-pr-create.mjs');
const { default: finalizeRelease } = await import('../.github/scripts/release-finalize.mjs');
const { default: cleanupBranches } = await import('../.github/scripts/release-branches-cleanup.mjs');

const context = { repo: { owner: 'raven-actions', repo: 'repo-files-sync' } };

/** Minimal @actions/core stand-in driven by an INPUT_* style map. */
function makeCore(inputs = {}) {
  const outputs = {};
  const summary = {
    addHeading: vi.fn(() => summary),
    addRaw: vi.fn(() => summary),
    addList: vi.fn(() => summary),
    write: vi.fn(() => Promise.resolve())
  };

  return {
    outputs,
    summary,
    getInput: vi.fn((name, options) => {
      const value = inputs[name] ?? '';
      if (options?.required && !value) throw new Error(`Input required: ${name}`);
      return value;
    }),
    getBooleanInput: vi.fn((name) => (inputs[name] ?? '').toLowerCase() === 'true'),
    getMultilineInput: vi.fn((name) =>
      (inputs[name] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    ),
    info: vi.fn(),
    warning: vi.fn(),
    notice: vi.fn(),
    setOutput: vi.fn((name, value) => {
      outputs[name] = value;
    })
  };
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

function makeGithub(overrides = {}) {
  const git = {
    getRef: vi.fn(),
    getCommit: vi.fn(),
    createBlob: vi.fn(async () => ({ data: { sha: 'blob-sha' } })),
    createTree: vi.fn(async () => ({ data: { sha: 'tree-sha' } })),
    createCommit: vi.fn(async () => ({ data: { sha: 'commit-sha' } })),
    createRef: vi.fn(async () => ({ data: {} })),
    updateRef: vi.fn(async () => ({ data: {} })),
    deleteRef: vi.fn(async () => ({ data: {} })),
    ...overrides.git
  };

  return {
    paginate: overrides.paginate ?? vi.fn(async () => []),
    rest: {
      git,
      repos: {
        getContent: vi.fn(),
        listBranches: vi.fn(),
        listReleases: vi.fn(),
        compareCommitsWithBasehead: vi.fn(async () => {
          throw httpError(404);
        }),
        ...overrides.repos
      },
      pulls: { list: vi.fn(async () => ({ data: [] })), create: vi.fn(), update: vi.fn(), ...overrides.pulls }
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.existsSync.mockReturnValue(true);
  fsMocks.readFileSync.mockReturnValue(Buffer.from('file contents'));
  fsMocks.statSync.mockReturnValue({ isDirectory: () => false });
  fsMocks.readdirSync.mockReturnValue([]);
});

describe('release-branch-assert-orphan.mjs', () => {
  const inputs = {
    BRANCH: 'prerelease/v1.2.3',
    BASE_BRANCH: 'main',
    EXPECTED_SHA: 'release-sha'
  };

  function refGithub() {
    return makeGithub({
      git: {
        getRef: vi.fn(async ({ ref }) => ({
          data: { object: { sha: ref === 'heads/main' ? 'main-sha' : 'release-sha' } }
        }))
      }
    });
  }

  it('accepts an unrelated artifact branch and exposes its verified sha', async () => {
    const github = refGithub();
    const core = makeCore(inputs);

    await verifyOrphanReleaseBranch({ context, github, core });

    expect(github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: 'raven-actions',
      repo: 'repo-files-sync',
      basehead: 'main...prerelease/v1.2.3'
    });
    expect(core.outputs['sha']).toBe('release-sha');
  });

  it('rejects a branch outside the release artifact namespaces', async () => {
    const core = makeCore({ ...inputs, BRANCH: 'release-prep/v1.2.3' });

    await expect(verifyOrphanReleaseBranch({ context, github: refGithub(), core })).rejects.toThrow(
      'must match prerelease/vX.Y.Z or release/vX.Y.Z'
    );
  });

  it('rejects an artifact branch whose tip differs from the expected sha', async () => {
    const core = makeCore({ ...inputs, EXPECTED_SHA: 'other-sha' });

    await expect(verifyOrphanReleaseBranch({ context, github: refGithub(), core })).rejects.toThrow(
      'moved: expected other-sha, found release-sha'
    );
  });
});

describe('release-branch-create.mjs', () => {
  const inputs = { TAG: 'v1.2.3', FILES: 'LICENSE\naction.yml', BRANCH_PREFIX: 'prerelease' };

  it('rejects a SOURCE_SHA that is not a full 40-character commit sha', async () => {
    const core = makeCore({ ...inputs, SOURCE_SHA: 'abc123' });

    await expect(createReleaseBranch({ context, github: makeGithub(), core })).rejects.toThrow(
      'SOURCE_SHA must be a full 40-character commit SHA'
    );
  });

  it('fails when a required release file is missing', async () => {
    fsMocks.existsSync.mockReturnValue(false);
    const core = makeCore(inputs);

    await expect(createReleaseBranch({ context, github: makeGithub(), core })).rejects.toThrow(
      'Required file missing: LICENSE'
    );
  });

  it('creates an orphan root commit when the branch does not exist yet', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => {
          throw httpError(404);
        })
      }
    });
    const core = makeCore({ ...inputs, SOURCE_SHA: 'a'.repeat(40) });

    await createReleaseBranch({ context, github, core });

    const commitArgs = github.rest.git.createCommit.mock.calls[0][0];
    // An orphan branch shares no history with main, so the first commit has no parents.
    expect(commitArgs.parents).toEqual([]);
    expect(commitArgs.message).toContain('Source-Commit: ' + 'a'.repeat(40));
    expect(github.rest.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/heads/prerelease/v1.2.3', sha: 'commit-sha' })
    );
    expect(core.outputs['sha']).toBe('commit-sha');
  });

  it('extends the existing branch history without forcing', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'tip-sha' } } })),
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'old-tree' } } }))
      }
    });
    const core = makeCore(inputs);

    await createReleaseBranch({ context, github, core });

    expect(github.rest.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ['tip-sha'] }));
    expect(github.rest.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  it('rejects an existing release branch that shares history with main', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'tip-sha' } } }))
      },
      repos: {
        compareCommitsWithBasehead: vi.fn(async () => ({ data: { status: 'ahead' } }))
      }
    });

    await expect(createReleaseBranch({ context, github, core: makeCore(inputs) })).rejects.toThrow(
      'prerelease/* and release/* branches must be orphan branches'
    );
    expect(github.rest.git.createCommit).not.toHaveBeenCalled();
    expect(github.rest.git.updateRef).not.toHaveBeenCalled();
  });

  it('leaves the branch untouched when a rerun produces an identical tree', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'tip-sha' } } })),
        // The rebuilt tree matches the current tip's tree exactly.
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'tree-sha' } } }))
      }
    });
    const core = makeCore(inputs);

    await createReleaseBranch({ context, github, core });

    expect(github.rest.git.createCommit).not.toHaveBeenCalled();
    expect(github.rest.git.updateRef).not.toHaveBeenCalled();
    expect(core.outputs['sha']).toBe('tip-sha');
  });

  it('rethrows unexpected errors while resolving the branch', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => {
          throw httpError(500);
        })
      }
    });

    await expect(createReleaseBranch({ context, github, core: makeCore(inputs) })).rejects.toThrow('HTTP 500');
  });
});

describe('release-pr-create.mjs', () => {
  const inputs = { VERSION: 'v1.2.3', NOTES: 'notes body', FILES: 'CHANGELOG.md', BRANCH_PREFIX: 'release-prep' };

  it('fails when a release file is missing', async () => {
    fsMocks.existsSync.mockReturnValue(false);

    await expect(createReleasePr({ context, github: makeGithub(), core: makeCore(inputs) })).rejects.toThrow(
      'Release file missing: CHANGELOG.md'
    );
  });

  it('creates the branch and opens a PR, exposing the branch name as an output', async () => {
    const github = makeGithub({
      git: {
        getRef: vi
          .fn()
          // Base branch lookup succeeds, release-prep branch does not exist yet.
          .mockImplementationOnce(async () => ({ data: { object: { sha: 'base-sha' } } }))
          .mockImplementationOnce(async () => {
            throw httpError(404);
          }),
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'base-tree' } } }))
      },
      pulls: { create: vi.fn(async () => ({ data: { number: 42, html_url: 'https://example.com/pull/42' } })) }
    });
    const core = makeCore(inputs);

    await createReleasePr({ context, github, core });

    expect(github.rest.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ['base-sha'] }));
    expect(github.rest.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/heads/release-prep/v1.2.3' })
    );
    expect(core.outputs['number']).toBe('42');
    expect(core.outputs['url']).toBe('https://example.com/pull/42');
    // Consumed by prepare-release.yml to dispatch CI on the release branch.
    expect(core.outputs['branch']).toBe('release-prep/v1.2.3');
  });

  it('reuses an open release PR instead of opening a duplicate', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'base-sha' } } })),
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'base-tree' } } }))
      },
      pulls: {
        list: vi.fn(async () => ({ data: [{ number: 7, html_url: 'https://example.com/pull/7' }] })),
        update: vi.fn(async () => ({ data: {} })),
        create: vi.fn()
      }
    });
    const core = makeCore(inputs);

    await createReleasePr({ context, github, core });

    // The branch already exists here, so it is fast-forwarded rather than created.
    expect(github.rest.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(github.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 7, title: 'chore(release): v1.2.3' })
    );
    expect(github.rest.pulls.create).not.toHaveBeenCalled();
    expect(core.outputs['number']).toBe('7');
  });

  it('rethrows unexpected errors while probing the release branch', async () => {
    const github = makeGithub({
      git: {
        getRef: vi
          .fn()
          .mockImplementationOnce(async () => ({ data: { object: { sha: 'base-sha' } } }))
          .mockImplementationOnce(async () => {
            throw httpError(500);
          }),
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'base-tree' } } }))
      }
    });

    await expect(createReleasePr({ context, github, core: makeCore(inputs) })).rejects.toThrow('HTTP 500');
  });
});

describe('release-finalize.mjs', () => {
  const inputs = { VERSION: 'v1.2.3', BRANCH: 'prerelease/v1.2.3' };

  const contentResponse = (readme) => ({
    data: { type: 'file', content: Buffer.from(readme, 'utf8').toString('base64') }
  });

  it('re-pins the README to the final tag on a new verified commit', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'rc-sha' } } })),
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'rc-tree' } } }))
      },
      repos: {
        getContent: vi.fn(async () => contentResponse('uses: raven-actions/repo-files-sync@v1.2.3-rc.4'))
      }
    });
    const core = makeCore(inputs);

    await finalizeRelease({ context, github, core });

    const blobArgs = github.rest.git.createBlob.mock.calls[0][0];
    expect(Buffer.from(blobArgs.content, 'base64').toString('utf8')).toContain('raven-actions/repo-files-sync@v1.2.3');
    // dist/ must carry over byte-identical, so only README.md is overlaid.
    expect(github.rest.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({ base_tree: 'rc-tree', tree: [expect.objectContaining({ path: 'README.md' })] })
    );
    expect(core.outputs['sha']).toBe('commit-sha');
  });

  it('is a no-op when the README already pins the final version', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'rc-sha' } } })),
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'rc-tree' } } }))
      },
      repos: { getContent: vi.fn(async () => contentResponse('uses: raven-actions/repo-files-sync@v1.2.3')) }
    });
    const core = makeCore(inputs);

    await finalizeRelease({ context, github, core });

    expect(github.rest.git.createCommit).not.toHaveBeenCalled();
    expect(github.rest.git.updateRef).not.toHaveBeenCalled();
    expect(core.outputs['sha']).toBe('rc-sha');
  });

  it('fails when the README cannot be read at the branch tip', async () => {
    const github = makeGithub({
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'rc-sha' } } })),
        getCommit: vi.fn(async () => ({ data: { tree: { sha: 'rc-tree' } } }))
      },
      repos: { getContent: vi.fn(async () => ({ data: [] })) }
    });

    await expect(finalizeRelease({ context, github, core: makeCore(inputs) })).rejects.toThrow(
      'README.md not found at the prerelease branch tip'
    );
  });
});

describe('release-branches-cleanup.mjs', () => {
  function cleanupGithub({ branches, releases, openPrs = [] }) {
    const github = makeGithub();
    github.paginate = vi.fn(async (endpoint) => {
      if (endpoint === github.rest.repos.listBranches) return branches.map((name) => ({ name }));
      if (endpoint === github.rest.repos.listReleases) return releases;
      return openPrs;
    });
    return github;
  }

  it('keeps the active carrier and deletes superseded and legacy rc branches', async () => {
    const github = cleanupGithub({
      branches: [
        'main',
        'prerelease/v0.1.0', // superseded: not ahead of the latest release
        'prerelease/v1.1.0', // active in-flight carrier
        'prerelease/v1.1.0-rc.2' // legacy per-RC branch
      ],
      releases: [{ tag_name: 'v1.0.0', draft: false, prerelease: false }]
    });
    const core = makeCore({});

    await cleanupBranches({ context, github, core });

    const deleted = github.rest.git.deleteRef.mock.calls.map((call) => call[0].ref);
    expect(deleted).toContain('heads/prerelease/v0.1.0');
    expect(deleted).toContain('heads/prerelease/v1.1.0-rc.2');
    expect(deleted).not.toContain('heads/prerelease/v1.1.0');
  });

  it('keeps release-prep branches that still back an open release PR', async () => {
    const github = cleanupGithub({
      branches: [
        'release-prep/v1.1.0',
        'release-prep/v0.9.0'
      ],
      releases: [],
      openPrs: [{ title: 'chore(release): v1.1.0' }]
    });

    await cleanupBranches({ context, github, core: makeCore({}) });

    const deleted = github.rest.git.deleteRef.mock.calls.map((call) => call[0].ref);
    expect(deleted).toEqual(['heads/release-prep/v0.9.0']);
  });

  it('deletes nothing in dry-run mode', async () => {
    const github = cleanupGithub({
      branches: ['release-prep/v0.9.0'],
      releases: []
    });
    const core = makeCore({ DRY_RUN: 'true' });

    await cleanupBranches({ context, github, core });

    expect(github.rest.git.deleteRef).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('[dry-run] would delete release-prep/v0.9.0');
  });

  it('tolerates branches that disappeared and warns on unexpected failures', async () => {
    const github = cleanupGithub({
      branches: [
        'release-prep/v0.9.0',
        'release-prep/v0.8.0'
      ],
      releases: []
    });
    github.rest.git.deleteRef
      .mockImplementationOnce(async () => {
        throw httpError(404);
      })
      .mockImplementationOnce(async () => {
        throw httpError(500);
      });
    const core = makeCore({});

    await cleanupBranches({ context, github, core });

    expect(core.info).toHaveBeenCalledWith('Already gone: release-prep/v0.9.0');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to delete release-prep/v0.8.0'));
  });

  it('reports when there is nothing to clean up', async () => {
    const github = cleanupGithub({ branches: ['main'], releases: [] });
    const core = makeCore({});

    await cleanupBranches({ context, github, core });

    expect(core.info).toHaveBeenCalledWith('No orphaned release branches found.');
    expect(github.rest.git.deleteRef).not.toHaveBeenCalled();
  });
});

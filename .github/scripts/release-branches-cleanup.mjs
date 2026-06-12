// @ts-check

/**
 * Deletes orphaned release-pipeline branches that the normal flow leaves behind.
 *
 * The happy path already cleans up: publish-release.yml deletes both
 * `prerelease/vX.Y.Z` and `release-prep/vX.Y.Z` when a final release is
 * published. These cases slip through and are handled here:
 *
 * - `prerelease/vX.Y.Z` whose cycle was SUPERSEDED before it ever shipped (e.g.
 *   a breaking change retargeted the computed version v0.1.0 -> v1.0.0, so
 *   v0.1.0 is never published and its branch lingers), or that survived its own
 *   release because of a failed cleanup.
 * - `prerelease/vX.Y.Z-rc.N` branches left behind by an older per-RC design. The
 *   current pipeline keeps a single `prerelease/vX.Y.Z` carrier for the whole RC
 *   cycle, so any -rc-suffixed branch is stale; its commit is preserved by the
 *   matching `vX.Y.Z-rc.N` tag.
 * - `release-prep/vX.Y.Z` whose release PR was closed without merging.
 *
 * What is KEPT (never deleted):
 * - The single highest-versioned STABLE-named `prerelease/vX.Y.Z` branch, and
 *   only while it is ahead of the latest published stable release. Versions only
 *   increase, so that branch is the active in-flight carrier.
 * - Every `release-prep/*` branch that still backs an OPEN `chore(release): …`
 *   pull request.
 *
 * Designed to be used with actions/github-script.
 *
 * Inputs (via environment variables INPUT_*):
 * - DRY_RUN (optional): when "true", only logs what would be deleted.
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context - GitHub Actions context
 * @param {import('@actions/github').GitHub} params.github - GitHub API client
 * @param {import('@actions/core')} params.core - GitHub Actions core
 */
export default async function main({ context, github, core }) {
  const { owner, repo } = context.repo

  // getBooleanInput throws on empty (scheduled runs pass no input), so guard it.
  const dryRunInput = core.getInput('DRY_RUN')
  const dryRun = dryRunInput ? core.getBooleanInput('DRY_RUN') : false

  const PRERELEASE_PREFIX = 'prerelease/'
  const RELEASE_PREP_PREFIX = 'release-prep/'
  const RELEASE_TITLE_PREFIX = 'chore(release): '

  /**
   * Parse a release/branch version into its comparable [major, minor, patch]
   * tuple plus whether it is a clean stable triple. Recognises both stable
   * `vX.Y.Z` and pre-release `vX.Y.Z-rc.N` names: the current pipeline only ever
   * creates `prerelease/vX.Y.Z`, so an -rc suffix marks a branch left behind by
   * an older per-RC design that must be cleaned up. Returns null for anything
   * that is not a recognisable version.
   * @param {string} value
   * @returns {{ version: [number, number, number], stable: boolean } | null}
   */
  const parseVersion = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?$/.exec(value)
    if (!match) return null
    return { version: [Number(match[1]), Number(match[2]), Number(match[3])], stable: !match[4] }
  }

  /**
   * @param {[number, number, number]} a
   * @param {[number, number, number]} b
   */
  const compareVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

  // All branches (paginated).
  const branches = await github.paginate(github.rest.repos.listBranches, {
    owner,
    repo,
    per_page: 100
  })
  const branchNames = branches.map((branch) => branch.name)

  // Highest published STABLE release (ignore drafts and pre-releases).
  const releases = await github.paginate(github.rest.repos.listReleases, {
    owner,
    repo,
    per_page: 100
  })
  /** @type {[number, number, number]} */
  let latestStable = [0, 0, 0]
  for (const release of releases) {
    if (release.draft || release.prerelease) continue
    const parsed = parseVersion(release.tag_name)
    if (parsed && parsed.stable && compareVersion(parsed.version, latestStable) > 0) {
      latestStable = parsed.version
    }
  }

  // prerelease/* - keep only the active in-flight carrier: the highest
  // STABLE-named branch (`prerelease/vX.Y.Z`) that is still ahead of the latest
  // published stable release. Everything else is an orphan: superseded/shipped
  // stable carriers, and `prerelease/vX.Y.Z-rc.N` branches left behind by an
  // older per-RC design (their commits are preserved by the matching -rc tags).
  const prereleaseBranches = branchNames
    .filter((name) => name.startsWith(PRERELEASE_PREFIX))
    .map((name) => ({ name, parsed: parseVersion(name.slice(PRERELEASE_PREFIX.length)) }))
    .filter(
      /** @returns {item is { name: string, parsed: { version: [number, number, number], stable: boolean } }} */
      (item) => item.parsed !== null
    )

  let activePrerelease = null
  for (const branch of prereleaseBranches) {
    if (!branch.parsed.stable) continue
    if (compareVersion(branch.parsed.version, latestStable) <= 0) continue
    if (!activePrerelease || compareVersion(branch.parsed.version, activePrerelease.parsed.version) > 0) {
      activePrerelease = branch
    }
  }

  /** @type {string[]} */
  const toDelete = []
  for (const branch of prereleaseBranches) {
    if (activePrerelease && branch.name === activePrerelease.name) continue
    toDelete.push(branch.name)
  }

  // release-prep/* - keep only those still backing an OPEN release PR.
  const openPrs = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100
  })
  const openReleaseVersions = new Set(
    openPrs
      .filter((pr) => pr.title.startsWith(RELEASE_TITLE_PREFIX))
      .map((pr) => pr.title.slice(RELEASE_TITLE_PREFIX.length).trim())
  )
  for (const name of branchNames.filter((name) => name.startsWith(RELEASE_PREP_PREFIX))) {
    const version = name.slice(RELEASE_PREP_PREFIX.length)
    if (!openReleaseVersions.has(version)) {
      toDelete.push(name)
    }
  }

  if (toDelete.length === 0) {
    core.info('No orphaned release branches found.')
    return
  }

  /** @type {string[]} */
  const deleted = []
  for (const name of toDelete) {
    if (dryRun) {
      core.info(`[dry-run] would delete ${name}`)
      deleted.push(name)
      continue
    }
    try {
      await github.rest.git.deleteRef({ owner, repo, ref: `heads/${name}` })
      core.info(`Deleted ${name}`)
      deleted.push(name)
    } catch (error) {
      const err = /** @type {{ status?: number, message?: string }} */ (error)
      if (err.status === 404 || err.status === 422) {
        core.info(`Already gone: ${name}`)
      } else {
        core.warning(`Failed to delete ${name}: ${err.message || String(error)}`)
      }
    }
  }

  await core.summary
    .addHeading('Release branch cleanup', 2)
    .addRaw(dryRun ? 'Dry run - the following branches would be deleted:' : 'Deleted orphaned branches:')
    .addList(deleted)
    .write()
}

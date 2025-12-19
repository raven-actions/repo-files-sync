// @ts-check

/**
 * Deletes the release branch used for publishing.
 *
 * This script is designed to be used with actions/github-script.
 *
 * Inputs (via environment variables INPUT_*):
 * - TAG (required): Release tag/version (e.g., "v1.0.0")
 * - BRANCH_PREFIX (optional): Branch prefix, default: "release"
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context - GitHub Actions context
 * @param {import('@actions/github').GitHub} params.github - GitHub API client
 * @param {import('@actions/core')} params.core - GitHub Actions core
 */
export default async function main({ context, github, core }) {
  const { owner, repo } = context.repo

  const tag = core.getInput('TAG', { required: true })
  const branchPrefix = core.getInput('BRANCH_PREFIX') || 'release'

  const branch = `${branchPrefix}/${tag}`

  core.info(`Deleting release branch ${branch}...`)

  try {
    await github.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${branch}`
    })

    core.info(`Deleted release branch ${branch}`)
  } catch (error) {
    const err = /** @type {{ status?: number; message?: string }} */ (error)

    // 404: ref not found (already deleted)
    // 422: validation failed / ref doesn't exist
    if (err.status === 404 || err.status === 422) {
      core.info(`Release branch ${branch} not found, skipping`)
      return
    }

    core.error(`Failed to delete release branch ${branch}`)
    throw error
  }
}

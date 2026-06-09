// @ts-check

import fs from 'node:fs'

/**
 * Opens (or updates) the release pull request for a final release.
 *
 * Creates a GitHub-verified commit on a `release-prep/<version>` branch that
 * adds/updates the changelog file on top of the base branch, then opens a PR
 * titled `chore(release): <version>`. Merging that PR is what triggers the
 * final publish (see publish-release.yml).
 *
 * This script is designed to be used with actions/github-script.
 *
 * Inputs (via environment variables INPUT_*):
 * - VERSION (required): Final release version (e.g. "v1.3.0")
 * - NOTES (optional): PR body / release notes (full notes since last final)
 * - FILES (optional): Multiline list of files to commit, default: "CHANGELOG.md"
 * - BRANCH_PREFIX (optional): Branch prefix, default: "release-prep"
 * - BASE_BRANCH (optional): Base branch, default: "main"
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context - GitHub Actions context
 * @param {import('@actions/github').GitHub} params.github - GitHub API client
 * @param {import('@actions/core')} params.core - GitHub Actions core
 */
export default async function main({ context, github, core }) {
  const { owner, repo } = context.repo

  const version = core.getInput('VERSION', { required: true })
  const notes = core.getInput('NOTES') || `Release ${version}`
  const filesInput = core.getMultilineInput('FILES')
  const files = filesInput.length ? filesInput : ['CHANGELOG.md']
  const branchPrefix = core.getInput('BRANCH_PREFIX') || 'release-prep'
  const baseBranch = core.getInput('BASE_BRANCH') || 'main'

  const branch = `${branchPrefix}/${version}`
  const title = `chore(release): ${version}`

  for (const file of files) {
    if (!fs.existsSync(file)) {
      throw new Error(`Release file missing: ${file}`)
    }
  }

  // Resolve base branch HEAD and its tree (so we commit ON TOP of main).
  core.info(`Resolving ${baseBranch} HEAD...`)
  const { data: baseRef } = await github.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` })
  const parentSha = baseRef.object.sha
  const { data: baseCommit } = await github.rest.git.getCommit({ owner, repo, commit_sha: parentSha })

  // One blob per file, layered on top of the base tree (adds/updates only these).
  /** @type {Array<{ path: string, mode: '100644', type: 'blob', sha: string }>} */
  const treeEntries = []
  for (const file of files) {
    const content = fs.readFileSync(file)
    const { data: blob } = await github.rest.git.createBlob({
      owner,
      repo,
      content: content.toString('base64'),
      encoding: 'base64'
    })
    treeEntries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const { data: tree } = await github.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeEntries
  })

  // Verified commit (GitHub signs commits created via the API).
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo,
    message: title,
    tree: tree.sha,
    parents: [parentSha]
  })
  core.info(`Created verified commit ${commit.sha}`)

  // Create or fast-forward the release-prep branch (idempotent for re-runs).
  let branchExists = true
  try {
    await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
  } catch (error) {
    const err = /** @type {{ status?: number }} */ (error)
    if (err.status === 404) {
      branchExists = false
    } else {
      throw error
    }
  }

  if (branchExists) {
    await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: true })
    core.info(`Updated branch ${branch}`)
  } else {
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha })
    core.info(`Created branch ${branch}`)
  }

  // Reuse an existing open PR for this branch, otherwise open a new one.
  const { data: openPrs } = await github.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${branch}`
  })

  let pr = openPrs[0]
  if (pr) {
    await github.rest.pulls.update({ owner, repo, pull_number: pr.number, title, body: notes })
    core.info(`Updated existing release PR #${pr.number}`)
  } else {
    const created = await github.rest.pulls.create({ owner, repo, title, head: branch, base: baseBranch, body: notes })
    pr = created.data
    core.info(`Opened release PR #${pr.number}`)
  }

  core.setOutput('number', String(pr.number))
  core.setOutput('url', pr.html_url)
  core.notice(`Release PR for ${version}: ${pr.html_url}`)
}

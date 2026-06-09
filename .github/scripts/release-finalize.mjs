// @ts-check

import { Buffer } from 'node:buffer'

/**
 * Re-pins the README usage examples to the final release tag at publish time.
 *
 * The final release is published at the last release candidate's commit, whose
 * README documents the RC tag (`vX.Y.Z-rc.N`). This appends a GitHub-verified
 * commit to the `prerelease/vX.Y.Z` branch that rewrites only the README version
 * pin to the final stable `vX.Y.Z`, so the tag cut from this commit advertises
 * its own version. `dist/` (the attested action code) is carried over verbatim
 * via `base_tree`, so it stays byte-identical to the RC and its attestation holds.
 *
 * If the README already pins the final version (nothing to change), the existing
 * branch tip is returned unchanged.
 *
 * This script is designed to be used with actions/github-script.
 *
 * Inputs (via environment variables INPUT_*):
 * - VERSION (required): Final release tag (e.g. "v1.3.0")
 * - BRANCH (required): Prerelease branch to finalize (e.g. "prerelease/v1.3.0")
 *
 * Outputs:
 * - sha: Commit SHA the final release tag should point at.
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context - GitHub Actions context
 * @param {import('@actions/github').GitHub} params.github - GitHub API client
 * @param {import('@actions/core')} params.core - GitHub Actions core
 */
export default async function main({ context, github, core }) {
  const { owner, repo } = context.repo
  const version = core.getInput('VERSION', { required: true })
  const branch = core.getInput('BRANCH', { required: true })

  // Current tip of the prerelease branch (the last RC commit).
  const { data: ref } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
  const tipSha = ref.object.sha
  const { data: tipCommit } = await github.rest.git.getCommit({ owner, repo, commit_sha: tipSha })

  // Read README.md at the RC commit and re-pin this action's version to the final tag.
  const { data: file } = await github.rest.repos.getContent({ owner, repo, path: 'README.md', ref: tipSha })
  if (Array.isArray(file) || file.type !== 'file' || typeof file.content !== 'string') {
    throw new Error('README.md not found at the prerelease branch tip')
  }
  const current = Buffer.from(file.content, 'base64').toString('utf8')

  const slug = `${owner}/${repo}`
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match `<owner>/<repo>@vX.Y.Z[-suffix]` and rewrite the version to the final tag.
  const pattern = new RegExp(`(${escapedSlug}@)v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?`, 'g')
  const updated = current.replace(pattern, `$1${version}`)

  if (updated === current) {
    core.info(`README already pins ${slug}@${version}; nothing to re-pin.`)
    core.setOutput('sha', tipSha)
    return
  }

  // Overlay only README.md on top of the RC tree, keeping dist/ etc. unchanged.
  const { data: blob } = await github.rest.git.createBlob({
    owner,
    repo,
    content: Buffer.from(updated, 'utf8').toString('base64'),
    encoding: 'base64'
  })
  const { data: tree } = await github.rest.git.createTree({
    owner,
    repo,
    base_tree: tipCommit.tree.sha,
    tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }]
  })
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo,
    message: `chore(release): ${version}`,
    tree: tree.sha,
    parents: [tipSha]
  })

  // Fast-forward the prerelease branch to the re-pinned commit so the release tag
  // (cut from this branch below) points at docs that match it. The branch is
  // deleted right after publishing.
  await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false })

  core.info(`Re-pinned README to ${slug}@${version} at ${commit.sha}`)
  core.setOutput('sha', commit.sha)
}

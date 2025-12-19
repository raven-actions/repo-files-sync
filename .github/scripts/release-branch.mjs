// @ts-check

import fs from 'node:fs'
import path from 'node:path'

/**
 * Creates a branch with only the required files for publishing.
 * This script is designed to be used with actions/github-script.
 *
 * Inputs (via environment variables INPUT_*):
 * - TAG (required): Release tag/version (e.g., "v1.0.0")
 * - FILES (required): Multiline list of files/directories to include
 * - BRANCH_PREFIX (optional): Branch prefix, default: "release"
 * - COMMIT_MESSAGE (optional): Commit message template, use {tag} placeholder, default: "chore(release): {tag}"
 * - BASE_BRANCH (optional): Base branch to create release from, default: "main"
 * - DELETE_EXISTING (optional): Delete existing branch if exists, default: "true"
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context - GitHub Actions context
 * @param {import('@actions/github').GitHub} params.github - GitHub API client
 * @param {import('@actions/core')} params.core - GitHub Actions core
 */
export default async function main({ context, github, core }) {
  const { owner, repo } = context.repo

  // Required inputs
  const tag = core.getInput('TAG', { required: true })
  const requiredFiles = core.getMultilineInput('FILES', { required: true })

  // Optional inputs with defaults
  const branchPrefix = core.getInput('BRANCH_PREFIX') || 'release'
  const commitMessageTemplate = core.getInput('COMMIT_MESSAGE') || 'chore(release): {tag}'
  const baseBranch = core.getInput('BASE_BRANCH') || 'main'

  // getBooleanInput throws if value is not a valid YAML boolean, so we need to check if input exists first
  const deleteExistingInput = core.getInput('DELETE_EXISTING')
  const deleteExisting = deleteExistingInput ? core.getBooleanInput('DELETE_EXISTING') : true

  const branch = `${branchPrefix}/${tag}`
  const commitMessage = commitMessageTemplate.replace(/{tag}/g, tag)

  // Validate required files exist
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required file missing: ${file}`)
    }
  }

  // Delete branch if it exists (remotely)
  if (deleteExisting) {
    core.info(`Deleting existing branch ${branch} if exists...`)
    try {
      await github.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branch}`
      })
      core.info(`Deleted existing branch ${branch}`)
    } catch (error) {
      const err = /** @type {{ status?: number }} */ (error)
      if (err.status !== 422 && err.status !== 404) {
        throw error
      }
    }
  }

  // Get base branch HEAD SHA (parent for new commit)
  core.info(`Getting ${baseBranch} branch HEAD...`)
  const { data: baseRef } = await github.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`
  })
  const parentSha = baseRef.object.sha

  /**
   * Create a blob from file content
   * @param {string} filePath - Path to the file
   * @returns {Promise<string>} - Blob SHA
   */
  async function createBlob(filePath) {
    const content = fs.readFileSync(filePath)
    const { data } = await github.rest.git.createBlob({
      owner,
      repo,
      content: content.toString('base64'),
      encoding: 'base64'
    })
    return data.sha
  }

  /**
   * Create a tree from entries
   * @param {Array<{path: string, mode: string, type: string, sha: string}>} entries
   * @returns {Promise<string>} - Tree SHA
   */
  async function createTree(entries) {
    const { data } = await github.rest.git.createTree({
      owner,
      repo,
      tree: entries
    })
    return data.sha
  }

  /**
   * Normalize path separators to forward slashes
   * @param {string} p - Path to normalize
   * @returns {string} - Normalized path
   */
  const normalizePath = p => p.replace(/\\/g, '/')

  /**
   * Build a nested tree structure from flat file paths
   * @param {Array<{filePath: string, blobSha: string}>} fileBlobs - File paths with their blob SHAs
   * @returns {Promise<string>} - Root tree SHA
   */
  async function buildTreeFromFiles(fileBlobs) {
    /** @type {Map<string, Array<{path: string, mode: string, type: string, sha: string}>>} */
    const dirEntries = new Map()

    // Organize files into their directories
    for (const { filePath, blobSha } of fileBlobs) {
      const dir = normalizePath(path.dirname(filePath))
      const normalizedDir = dir === '.' ? '' : dir

      if (!dirEntries.has(normalizedDir)) {
        dirEntries.set(normalizedDir, [])
      }
      dirEntries.get(normalizedDir)?.push({
        path: path.basename(filePath),
        mode: '100644',
        type: 'blob',
        sha: blobSha
      })
    }

    // Collect all unique directory paths (including parent dirs without direct files)
    const uniqueDirs = new Set([...dirEntries.keys()].filter(d => d !== ''))
    for (const dir of [...uniqueDirs]) {
      const parts = dir.split('/')
      for (let i = 1; i < parts.length; i++) {
        uniqueDirs.add(parts.slice(0, i).join('/'))
      }
    }

    // Sort directories deepest first for bottom-up tree creation
    const sortedDirs = [...uniqueDirs].sort(
      (a, b) => b.split('/').length - a.split('/').length
    )

    // Create trees from deepest to root
    /** @type {Map<string, string>} */
    const treeShas = new Map()

    for (const dir of sortedDirs) {
      const entries = dirEntries.get(dir) || []

      // Add child directory trees
      for (const [childDir, sha] of treeShas) {
        const parentDir = normalizePath(path.dirname(childDir))
        if ((parentDir === '.' ? '' : parentDir) === dir) {
          entries.push({
            path: path.basename(childDir),
            mode: '040000',
            type: 'tree',
            sha
          })
        }
      }

      if (entries.length > 0) {
        treeShas.set(dir, await createTree(entries))
      }
    }

    // Build root tree
    const rootEntries = dirEntries.get('') || []
    for (const [dir, sha] of treeShas) {
      if (!dir.includes('/')) {
        rootEntries.push({
          path: dir,
          mode: '040000',
          type: 'tree',
          sha
        })
      }
    }

    return createTree(rootEntries)
  }

  // Collect all files to include (expand directories)
  core.info('Collecting files...')
  /** @type {string[]} */
  const allFiles = []
  for (const filePath of requiredFiles) {
    if (fs.statSync(filePath).isDirectory()) {
      const files = fs.readdirSync(filePath, { recursive: true, withFileTypes: true })
      for (const entry of files) {
        if (entry.isFile()) {
          allFiles.push(path.join(entry.parentPath, entry.name))
        }
      }
    } else {
      allFiles.push(filePath)
    }
  }

  core.info(`Found ${allFiles.length} files to include`)

  // Create blobs for all files in parallel
  core.info('Creating blobs...')
  const fileBlobs = await Promise.all(
    allFiles.map(async filePath => ({
      filePath: normalizePath(filePath),
      blobSha: await createBlob(filePath)
    }))
  )

  // Build tree structure
  core.info('Creating trees...')
  const rootTreeSha = await buildTreeFromFiles(fileBlobs)

  // Create commit with parent from base branch (will be verified)
  core.info('Creating verified commit...')
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: rootTreeSha,
    parents: [parentSha]
  })

  // Create branch ref pointing to the new commit
  core.info('Creating branch...')
  await github.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: commit.sha
  })

  core.info(`Created branch ${branch} from ${baseBranch} with verified commit ${commit.sha}`)

  // Set outputs
  core.setOutput('name', branch)
  core.setOutput('sha', commit.sha)

  return branch
}

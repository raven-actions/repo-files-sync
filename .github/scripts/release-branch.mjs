// @ts-check

import fs from 'node:fs'
import path from 'node:path'

/**
 * Creates a release branch with only the required files for publishing.
 * This script is designed to be used with actions/github-script.
 *
 * @param {Object} params
 * @param {import('@actions/github').GitHub} params.github - GitHub API client
 * @param {import('@actions/github').Context} params.context - GitHub Actions context
 * @param {import('@actions/core')} params.core - GitHub Actions core
 */
export default async function createReleaseBranch({ github, context, core }) {
  const { owner, repo } = context.repo

  // Get inputs
  const releaseTag = core.getInput('TAG', { required: true })
  const requiredFiles = core.getMultilineInput('FILES', { required: true })

  const releaseBranch = `release/${releaseTag}`

  // Validate required files exist
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required file missing: ${file}`)
    }
  }

  // Delete branch if it exists (remotely)
  core.info(`Deleting existing branch ${releaseBranch} if exists...`)
  try {
    await github.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${releaseBranch}`
    })
    core.info(`Deleted existing branch ${releaseBranch}`)
  } catch (error) {
    const err = /** @type {{ status?: number }} */ (error)
    if (err.status !== 422 && err.status !== 404) {
      throw error
    }
  }

  // Get main branch HEAD SHA (parent for new commit)
  core.info('Getting main branch HEAD...')
  const { data: mainRef } = await github.rest.git.getRef({
    owner,
    repo,
    ref: 'heads/main'
  })
  const parentSha = mainRef.object.sha

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
   * @param {Array<{path: string, mode: string, type: string, sha: string}>} tree
   * @returns {Promise<string>} - Tree SHA
   */
  async function createTree(tree) {
    const { data } = await github.rest.git.createTree({
      owner,
      repo,
      tree
    })
    return data.sha
  }

  /**
   * Recursively collect all files from a directory
   * @param {string} dirPath - Directory path
   * @returns {string[]} - Array of file paths relative to dirPath
   */
  function collectFilesRecursively(dirPath) {
    const files = []
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        files.push(...collectFilesRecursively(fullPath))
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
    return files
  }

  /**
   * Build a nested tree structure from flat file paths
   * @param {Array<{filePath: string, blobSha: string}>} fileBlobs - File paths with their blob SHAs
   * @returns {Promise<string>} - Root tree SHA
   */
  async function buildTreeFromFiles(fileBlobs) {
    // Group files by their directory structure
    // { '': [...root files], 'dir': [...], 'dir/subdir': [...] }
    /** @type {Map<string, Array<{name: string, mode: string, type: string, sha: string}>>} */
    const dirEntries = new Map()

    // First pass: organize files into directories
    for (const { filePath, blobSha } of fileBlobs) {
      const dir = path.dirname(filePath)
      const name = path.basename(filePath)
      const normalizedDir = dir === '.' ? '' : dir.replace(/\\/g, '/')

      if (!dirEntries.has(normalizedDir)) {
        dirEntries.set(normalizedDir, [])
      }
      /** @type {Array<{name: string, mode: string, type: string, sha: string}>} */ (dirEntries.get(normalizedDir)).push({
        name,
        mode: '100644',
        type: 'blob',
        sha: blobSha
      })
    }

    // Get all unique directories sorted by depth (deepest first)
    const allDirs = [...dirEntries.keys()].filter(d => d !== '')
    const uniqueDirs = new Set(allDirs)

    // Also add parent directories that might only contain subdirs (no direct files)
    for (const dir of allDirs) {
      const parts = dir.split('/')
      for (let i = 1; i < parts.length; i++) {
        uniqueDirs.add(parts.slice(0, i).join('/'))
      }
    }

    const sortedDirs = [...uniqueDirs].sort((a, b) => {
      const depthA = a.split('/').length
      const depthB = b.split('/').length
      return depthB - depthA // Deepest first
    })

    // Create trees from deepest to root, storing tree SHAs
    /** @type {Map<string, string>} */
    const treeShas = new Map()

    for (const dir of sortedDirs) {
      const entries = dirEntries.get(dir) || []

      // Add subdirectory trees
      for (const [subDir, sha] of treeShas) {
        const parentDir = path.dirname(subDir).replace(/\\/g, '/')
        const normalizedParent = parentDir === '.' ? '' : parentDir
        if (normalizedParent === dir) {
          entries.push({
            name: path.basename(subDir),
            mode: '040000',
            type: 'tree',
            sha
          })
        }
      }

      if (entries.length > 0) {
        const treeEntries = entries.map(e => ({
          path: e.name,
          mode: e.mode,
          type: e.type,
          sha: e.sha
        }))
        const treeSha = await createTree(treeEntries)
        treeShas.set(dir, treeSha)
      }
    }

    // Build root tree
    const rootEntries = dirEntries.get('') || []

    // Add top-level directory trees
    for (const [dir, sha] of treeShas) {
      if (!dir.includes('/')) {
        rootEntries.push({
          name: dir,
          mode: '040000',
          type: 'tree',
          sha
        })
      }
    }

    const rootTreeEntries = rootEntries.map(e => ({
      path: e.name,
      mode: e.mode,
      type: e.type,
      sha: e.sha
    }))

    return await createTree(rootTreeEntries)
  }

  // Collect all files to include (expand directories)
  core.info('Collecting files...')
  const allFiles = []
  for (const filePath of requiredFiles) {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      const filesInDir = collectFilesRecursively(filePath)
      allFiles.push(...filesInDir)
    } else {
      allFiles.push(filePath)
    }
  }

  core.info(`Found ${allFiles.length} files to include`)

  // Create blobs for all files
  core.info('Creating blobs...')
  const fileBlobs = await Promise.all(
    allFiles.map(async filePath => ({
      filePath: filePath.replace(/\\/g, '/'),
      blobSha: await createBlob(filePath)
    }))
  )

  // Build tree structure
  core.info('Creating trees...')
  const rootTreeSha = await buildTreeFromFiles(fileBlobs)

  // Create commit with parent from main (will be verified)
  core.info('Creating verified commit...')
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo,
    message: `chore(release): ${releaseTag}`,
    tree: rootTreeSha,
    parents: [parentSha]
  })

  // Create branch ref pointing to the new commit
  core.info('Creating release branch...')
  await github.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${releaseBranch}`,
    sha: commit.sha
  })

  core.info(`Created release branch ${releaseBranch} from main with verified commit ${commit.sha}`)

  return releaseBranch
}

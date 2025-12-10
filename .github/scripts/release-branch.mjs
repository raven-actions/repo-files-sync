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
 * @param {import('@actions/github-script').AsyncFunctionArguments} params.AsyncFunctionArguments - GitHub Script function arguments
 */
export default async function createReleaseBranch({ github, context, core }) {
  const { owner, repo } = context.repo

  // Get release tag from input
  const releaseTag = core.getInput('RELEASE_TAG', { required: true })

  const releaseBranch = `release/${releaseTag}`

  // Required files to include in release branch
  const requiredFiles = [
    'LICENSE',
    'README.md',
    'action.yml',
    '.github/workflows/publish.yml'
  ]

  // Validate required files exist
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required file missing: ${file}`)
    }
  }

  // Validate dist directory has files
  const distPath = 'dist'
  if (!fs.existsSync(distPath) || fs.readdirSync(distPath).length === 0) {
    throw new Error('dist directory is empty or missing')
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
    if (error.status !== 422 && error.status !== 404) {
      throw error
    }
    // Branch doesn't exist, continue
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

  // Create blobs for required files
  core.info('Creating blobs...')
  const [licenseBlob, readmeBlob, actionBlob, publishBlob] = await Promise.all([
    createBlob('LICENSE'),
    createBlob('README.md'),
    createBlob('action.yml'),
    createBlob('.github/workflows/publish.yml')
  ])

  // Create blobs for dist files
  const distFiles = fs.readdirSync(distPath).filter(file => {
    const filePath = path.join(distPath, file)
    return fs.statSync(filePath).isFile()
  })

  const distBlobPromises = distFiles.map(async file => {
    const filePath = path.join(distPath, file)
    const sha = await createBlob(filePath)
    return { path: file, mode: '100644', type: 'blob', sha }
  })
  const distEntries = await Promise.all(distBlobPromises)

  // Create all trees
  core.info('Creating trees...')

  // Create dist tree
  const distTreeSha = await createTree(distEntries)

  // Create .github/workflows tree
  const workflowsTreeSha = await createTree([
    { path: 'publish.yml', mode: '100644', type: 'blob', sha: publishBlob }
  ])

  // Create .github tree
  const githubTreeSha = await createTree([
    { path: 'workflows', mode: '040000', type: 'tree', sha: workflowsTreeSha }
  ])

  // Create root tree
  const rootTreeSha = await createTree([
    { path: 'LICENSE', mode: '100644', type: 'blob', sha: licenseBlob },
    { path: 'README.md', mode: '100644', type: 'blob', sha: readmeBlob },
    { path: 'action.yml', mode: '100644', type: 'blob', sha: actionBlob },
    { path: 'dist', mode: '040000', type: 'tree', sha: distTreeSha },
    { path: '.github', mode: '040000', type: 'tree', sha: githubTreeSha }
  ])

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

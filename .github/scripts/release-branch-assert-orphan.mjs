// @ts-check

/**
 * Verifies that a release artifact branch has no common ancestor with the base
 * branch. GitHub's compare API returns 404 only after both refs have been
 * resolved when their histories are unrelated.
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context
 * @param {import('@actions/github').GitHub} params.github
 * @param {import('@actions/core')} params.core
 * @param {string} params.branch
 * @param {string} params.baseBranch
 * @param {string} [params.expectedSha]
 * @returns {Promise<string>}
 */
export async function assertOrphanReleaseBranch({ context, github, core, branch, baseBranch, expectedSha }) {
  const { owner, repo } = context.repo;

  if (!/^(?:prerelease|release)\/v\d+\.\d+\.\d+$/.test(branch)) {
    throw new Error(`Release artifact branch must match prerelease/vX.Y.Z or release/vX.Y.Z: ${branch}`);
  }

  try {
    await github.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  } catch (error) {
    const err = /** @type {{ status?: number }} */ (error);
    if (err.status === 404) {
      throw new Error(`Base branch not found: ${baseBranch}`, { cause: error });
    }
    throw error;
  }

  let branchSha;
  try {
    const { data: branchRef } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    branchSha = branchRef.object.sha;
  } catch (error) {
    const err = /** @type {{ status?: number }} */ (error);
    if (err.status === 404) {
      throw new Error(`Release artifact branch not found: ${branch}`, { cause: error });
    }
    throw error;
  }

  if (expectedSha && branchSha !== expectedSha) {
    throw new Error(`Release artifact branch ${branch} moved: expected ${expectedSha}, found ${branchSha}`);
  }

  try {
    await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseBranch}...${branch}`
    });
  } catch (error) {
    const err = /** @type {{ status?: number }} */ (error);
    if (err.status === 404) {
      core.info(`Verified ${branch} is orphaned from ${baseBranch} at ${branchSha}.`);
      return branchSha;
    }
    throw error;
  }

  throw new Error(
    `Release artifact branch ${branch} shares history with ${baseBranch}; ` +
      'prerelease/* and release/* branches must be orphan branches'
  );
}

/**
 * actions/github-script entrypoint.
 *
 * Inputs (via environment variables INPUT_*):
 * - BRANCH (required): Release artifact branch to verify
 * - BASE_BRANCH (required): Repository branch the artifact must be orphaned from
 * - EXPECTED_SHA (optional): Expected current artifact branch tip
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context
 * @param {import('@actions/github').GitHub} params.github
 * @param {import('@actions/core')} params.core
 */
export default async function main({ context, github, core }) {
  const branch = core.getInput('BRANCH', { required: true });
  const baseBranch = core.getInput('BASE_BRANCH', { required: true });
  const expectedSha = core.getInput('EXPECTED_SHA') || undefined;
  const sha = await assertOrphanReleaseBranch({ context, github, core, branch, baseBranch, expectedSha });
  core.setOutput('sha', sha);
}

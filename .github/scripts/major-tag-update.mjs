// @ts-check

/**
 * Moves the floating major and minor tags to the published release commit.
 *
 * For a stable release tag like "v1.2.3", this points "v1" and "v1.2" at the
 * same commit, so consumers pinning "@v1" (or "@v1.2") receive updates without
 * having to bump the exact patch version.
 *
 * These floating aliases are intentionally plain, movable Git tags and are NOT
 * published as GitHub releases. This is required to stay compatible with
 * immutable releases: only the exact version tag (e.g. v1.2.3) is published as
 * an immutable release (which locks its tag to a commit), while the major/minor
 * aliases must remain movable so consumers pinning @v1 / @v1.2 keep receiving
 * updates.
 * See: https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases
 *
 * Prereleases and non-semver tags are ignored.
 *
 * This script is designed to be used with actions/github-script.
 *
 * Inputs (via environment variables INPUT_*):
 * - TAG (required): Release tag/version (e.g., "v1.2.3")
 *
 * @param {Object} params
 * @param {import('@actions/github').Context} params.context - GitHub Actions context
 * @param {import('@actions/github').GitHub} params.github - GitHub API client
 * @param {import('@actions/core')} params.core - GitHub Actions core
 */
export default async function main({ context, github, core }) {
  const { owner, repo } = context.repo

  const tag = core.getInput('TAG', { required: true })

  // Only move aliases for stable semver tags (e.g. v1.2.3 or 1.2.3).
  // Prereleases (e.g. v1.2.3-rc.1) and other formats are skipped, so we never
  // point a floating alias at a prerelease commit.
  const match = tag.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    core.info(`Tag ${tag} is not a stable semver tag, skipping major/minor tag update`)
    return
  }

  const [, prefix, major, minor] = match
  const aliases = [`${prefix}${major}`, `${prefix}${major}.${minor}`]

  // Resolve the commit that the immutable release tag points to.
  const { data: ref } = await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` })

  let sha = ref.object.sha
  if (ref.object.type === 'tag') {
    // Annotated tag -> dereference to the underlying commit.
    const { data: tagObject } = await github.rest.git.getTag({ owner, repo, tag_sha: sha })
    sha = tagObject.object.sha
  }

  for (const alias of aliases) {
    if (alias === tag) {
      continue
    }

    core.info(`Pointing ${alias} -> ${sha}`)

    try {
      // Check whether the alias tag already exists so we can decide between
      // a forced move (update) and an initial create, instead of relying on
      // the status code returned by updateRef.
      let exists = true
      try {
        await github.rest.git.getRef({ owner, repo, ref: `tags/${alias}` })
      } catch (error) {
        const err = /** @type {{ status?: number }} */ (error)
        if (err.status === 404) {
          exists = false
        } else {
          throw error
        }
      }

      if (exists) {
        await github.rest.git.updateRef({ owner, repo, ref: `tags/${alias}`, sha, force: true })
        core.info(`Updated existing tag ${alias}`)
      } else {
        await github.rest.git.createRef({ owner, repo, ref: `refs/tags/${alias}`, sha })
        core.info(`Created tag ${alias}`)
      }
    } catch (error) {
      const err = /** @type {{ status?: number; message?: string }} */ (error)

      // 403/422: the tag is protected (e.g. it was attached to an immutable
      // release, or a tag protection ruleset blocks the workflow token).
      // Floating aliases must stay as plain, movable tags.
      if (err.status === 403 || err.status === 422) {
        core.error(
          `Failed to move ${alias}: the tag appears to be protected. ` +
            `Floating major/minor tags must NOT be attached to a GitHub release ` +
            `(immutable releases lock their tags), and any tag protection ruleset ` +
            `must allow this workflow to update them.`
        )
      } else {
        core.error(`Failed to update tag ${alias}: ${err.message ?? 'unknown error'}`)
      }

      throw error
    }
  }
}

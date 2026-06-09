# Releasing & rollback runbook

Maintainer-facing notes for cutting, promoting, and rolling back releases. The
pipeline is automated; this document covers the manual decision points and the
break-glass procedures.

## Model at a glance

- **Release candidates (RCs)** are prepared automatically on every merge to
  `main`, but always as a **draft** `vX.Y.Z-rc.N` prerelease. The single draft is
  overwritten in place on each run (keeping the same proposed number) until a
  maintainer **manually promotes** it by publishing the draft. Its notes show only
  the incremental changes since the previously promoted RC.
- **The final release** is opened deliberately via the **Prepare Release**
  workflow, reviewed as a pull request, and published on merge. Its notes contain
  **all** changes since the previous final release, and it is tagged at the exact
  commit of the last RC (no rebuild).

## How a release candidate is produced

1. **Merge to `main`.** PR titles must follow [Conventional Commits](https://www.conventionalcommits.org)
   (enforced by the `PR Title` workflow). With squash-merge the PR title becomes
   the commit subject that drives version bumping. **Use squash merges.**
2. **CI** (`ci.yml`) runs lint, type-check, build, and the cross-OS test matrix.
3. **Prerelease** (`prerelease.yml`) runs on CI success for `main` (and is skipped
   for `chore(release)` commits):
   - rebuilds `dist/` from the exact tested commit and attaches a signed SLSA
     build provenance attestation,
   - skips entirely if no version-bumping commits landed (no-op guard),
   - pins the `README.md` usage examples to the target stable `vX.Y.Z`, so the
     curated tree the final tag will point at advertises the correct version,
   - creates a GitHub-**verified** commit on the `prerelease/vX.Y.Z` branch
     (curated release files only); this branch tip always points at the latest RC,
   - overwrites the pending **draft** prerelease `vX.Y.Z-rc.N` (deleting any
     previous draft RC first), so at most one draft is ever pending and it targets
     that branch tip.

**Promoting a draft to a real RC.** RCs are never published automatically. When a
draft looks good, open it on the **Releases** page and click **Publish release**.
That creates the immutable `vX.Y.Z-rc.N` tag at the current `prerelease/vX.Y.Z`
branch tip and advances the proposed number for the next draft.

## Cutting the final release

1. Run the **Prepare Release** workflow (Actions tab -> Prepare Release -> Run
   workflow). It:
   - computes the target version and the **full** notes since the last final
     release,
   - verifies a `prerelease/vX.Y.Z` branch exists (i.e. an RC was cut),
   - updates `CHANGELOG.md` and pins the `README.md` usage examples to
     `vX.Y.Z` (so the default branch docs match the published tag),
   - opens a PR titled `chore(release): vX.Y.Z` with the full notes as its body.
2. Review the PR (notes + `CHANGELOG.md`). Edit the PR body if you want to adjust
   the published notes. **Merge it** (squash).
3. `publish-release.yml` runs on the merge and:
   - tags `vX.Y.Z` at the tip of `prerelease/vX.Y.Z` (the exact last RC commit)
     and marks it `latest`,
   - deletes the `prerelease/vX.Y.Z` and `release-prep/vX.Y.Z` branches.

> The release PR is created by the workflow token, so token-triggered checks
> (such as `PR Title`) do not re-run on it. The title is correct by construction.
> If you make those checks required, exclude `release-prep/*` or create the PR
> with a PAT.

## Rollback

> Prefer a **forward fix**. Published release tags are immutable and cannot be
> re-pointed, so the cleanest recovery for a bad release is to ship the next
> patch.

### The release PR hasn't been merged yet

Close (or delete) the PR; nothing is published until it merges. Re-run **Prepare
Release** to regenerate it.

### A bad version was published (forward fix - preferred)

1. Revert the offending change on `main` (`git revert <sha>`), open a PR, merge.
2. Let an RC build, then run **Prepare Release** again to publish the next patch
   (e.g. `v1.2.3` -> `v1.2.4`). Consumers move forward by bumping the pinned
   exact version (Dependabot raises that bump automatically).

### Break-glass: stop consumers from getting a bad release

Exact version tags are immutable and cannot be moved, so the only levers are the
**Latest** pointer and the release listing. Point **Latest** back at the previous
good release and de-list the bad one:

```bash
# restore the "Latest" badge to the previous good release
gh release edit "<prev-version>" --latest

# de-list the bad release (or delete it from the Releases page)
gh release edit "<bad-version>" --draft
```

Consumers pinned to the bad exact tag recover by bumping to the fixed version
once it ships (Dependabot raises that bump automatically).

## Notes

- This project publishes only exact, immutable `vX.Y.Z` tags - there are no
  floating `latest` / `v<major>` / `v<major>.<minor>` aliases to maintain.
- `dist/` is rebuilt in CI and provenance-signed; verify any published artifact
  with `gh attestation verify dist/index.mjs --repo <owner>/<repo>`.

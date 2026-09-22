# Releasing & rollback runbook

Maintainer-facing notes for cutting, promoting, and rolling back releases. The pipeline is automated; this document covers the manual decision points and the break-glass procedures.

## Model at a glance

- **Release candidates (RCs)** are prepared automatically on every merge to `main`, but always as a **draft** `vX.Y.Z-rc.N` prerelease. The single draft is overwritten in place on each run (keeping the same proposed number) until a maintainer **manually promotes** it by publishing the draft. Its notes show only the incremental changes since the previously promoted RC.
- **The final release** is opened deliberately via the **Prepare Release** workflow, reviewed as a pull request, and published on merge. Its notes contain **all** changes since the previous final release. It is tagged at the last RC commit with the README usage examples re-pinned from the RC tag to the final `vX.Y.Z`; only the README changes, so `dist/` stays byte-identical to the RC.

## Lifecycle at a glance

```mermaid
flowchart TD
    subgraph merge_cycle["Per merge to main · automated"]
        direction TB
        PR["PR merged to main<br/>(squash · Conventional Commit)"]
        CI["CI workflow<br/>lint · typecheck · build · test"]
        SKIP["Skipped · no-op<br/>(chore release commit or no version bump)"]
        PRE["Prerelease workflow<br/>rebuild dist + SLSA provenance<br/>pin README to vX.Y.Z-rc.N<br/>verified commit on orphan prerelease/vX.Y.Z"]
        DRAFT["Draft prerelease vX.Y.Z-rc.N<br/>overwritten in place each run"]
        PR --> CI
        CI -->|"success & releasable"| PRE
        CI -.->|"not releasable"| SKIP
        PRE --> DRAFT
        DRAFT -.->|"next merge to main"| PR
    end

    RCTAG["Immutable RC tag vX.Y.Z-rc.N<br/>(proposed number advances)"]

    subgraph final_cut["Cut the final release"]
        direction TB
        PREP["Prepare Release workflow<br/>full notes + CHANGELOG<br/>pin README to vX.Y.Z"]
        VERIFY{"prerelease/vX.Y.Z tip<br/>matches latest RC tag?"}
        PUBFIRST["Publish the pending draft RC,<br/>then re-run Prepare Release"]
        RELPR["Release PR · chore release: vX.Y.Z"]
        PUB["Publish Release workflow<br/>re-pin README to vX.Y.Z · dist unchanged<br/>tag · mark latest · delete release branches"]
        FINAL["Final release vX.Y.Z<br/>tagged at the last RC commit"]
        PREP --> VERIFY
        VERIFY -.->|no| PUBFIRST
        VERIFY -->|yes| RELPR
        RELPR ==>|"review & merge"| PUB
        PUB --> FINAL
    end

    CLEAN["Cleanup Release Branches<br/>weekly / on demand"]

    DRAFT ==>|"Publish release"| RCTAG
    RCTAG ==>|"run Prepare Release"| PREP
    PUBFIRST -.-> PREP
    CLEAN -.->|"remove orphaned prerelease/* and release-prep/*"| FINAL

    classDef auto fill:#cfe2ff,stroke:#0d6efd,color:#03204e;
    classDef artifact fill:#d1e7dd,stroke:#198754,color:#0a3622;
    classDef neutral fill:#e2e3e5,stroke:#6c757d,color:#1b1e21;
    class CI,PRE,PREP,PUB,CLEAN auto;
    class RCTAG,FINAL artifact;
    class DRAFT,SKIP,PUBFIRST,RELPR neutral;
```

- **Bold arrows** are the three manual maintainer gates - publish a draft to mint the `vX.Y.Z-rc.N` tag, run **Prepare Release**, and review & merge the release PR.
- **Dotted arrows** are skip / loop / return / cleanup paths; solid arrows are automated hand-offs. Green nodes are the immutable, published artifacts (RC tags and the final release); blue nodes are the workflows that produce them.

## How a release candidate is produced

1. **Merge to `main`.** PR titles must follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by the `PR Title` workflow). With squash-merge the PR title becomes the commit subject that drives version bumping. **Use squash merges.**

   > Because version bumping and changelog generation read the squashed commit subject, configure the repository to **allow squash merging only** (Settings -> General -> Pull Requests: enable "Allow squash merging", disable merge commits and rebase merging, and default the squash commit message to the PR title). A stray merge or rebase merge can land non-conventional subjects that break `git cliff --bump` and the notes.
2. **CI** (`ci.yml`) runs lint, type-check, build, and the cross-OS test matrix.
3. **Prerelease** (`prerelease.yml`) runs on CI success for a **push to this repository's own default branch** (and is skipped for `chore(release)` commits):
   - rebuilds `dist/` from the exact tested commit and attaches a signed SLSA build provenance attestation,
   - computes version bumps from the last published stable release's recorded source commit and skips when no releasable source changes remain (including no incremental changes after the latest published RC),
   - pins the `README.md` usage examples to the RC tag `vX.Y.Z-rc.N`, so the draft/prerelease advertises the exact version a consumer would install from it (the final release re-pins these to the stable `vX.Y.Z` when cut),
   - creates a GitHub-**verified** commit on the `prerelease/vX.Y.Z` branch (curated release files only); this branch tip always points at the latest RC. The branch is an **orphan branch** - it shares no history with `main`, so its commits read as "here are the release artifacts" instead of a commit that deletes the rest of the repository. The CI-tested `main` commit the artifacts were built from is recorded as a `Source-Commit:` trailer in the commit message. A rerun leaves the branch untouched only when both its artifacts and source SHA match; an identical tree built from a different source records the new source boundary,
   - overwrites the pending **draft** prerelease `vX.Y.Z-rc.N` (deleting any previous draft RC first), so at most one draft is ever pending and it targets that branch tip.

   > **Why the trigger is gated.** `workflow_run` starts with a privileged token even when the run that triggered it was an unprivileged pull request from a fork, and its `branches:` filter matches the triggering run's *head* branch name - which a fork can freely name `main`. Because both jobs check out `workflow_run.head_sha` and execute code from that checkout, each one requires `workflow_run.event == 'push'`, `head_repository.full_name == github.repository`, and `head_branch == <default branch>`. Keep those conditions on any job added to this workflow, and never run code from an untrusted `head_sha` in a job that holds write permissions.

> **Release artifact branches are always orphan branches.** Every `prerelease/vX.Y.Z` branch, and any future `release/vX.Y.Z` artifact branch, must have no common ancestor with the default branch. The branch creator checks existing carriers before extending them, and each workflow re-verifies ancestry before creating an RC or final release. Never use the `prerelease/*` or `release/*` namespaces for ordinary development or configuration PRs.

**Promoting a draft to a real RC.** RCs are never published automatically. When a draft looks good, open it on the **Releases** page and click **Publish release**. That creates the immutable `vX.Y.Z-rc.N` tag at the current `prerelease/vX.Y.Z` branch tip and advances the proposed number for the next draft.

## Cutting the final release

### Source history and version labels

Release tags identify orphan artifact commits, not positions in the source history. The workflows resolve published releases to their `Source-Commit` trailers and pass source-to-source ranges to the pinned git-cliff CLI. Tag discovery is disabled for those ranges; the prior version is supplied separately through git-cliff's JSON context, so old features cannot cause another version bump.

The first release uses the full source history and the configured initial version (`v2.0.0`). Later stable notes span the previous stable source through the published RC's source. RC notes contain only changes after the previous published RC's source. Full changelog sections and compare links use these same source boundaries.

Drafts and tags without a published release do not establish a released baseline. Missing, duplicate, malformed, unknown, or non-ancestor source metadata stops generation rather than silently treating the artifact tag as a source commit. The final README-only commit preserves `Source-Commit` so subsequent releases retain the correct boundary.

The [release-history tests](../tests/release-history.test.mjs) use temporary Git repositories.
Set `RELEASE_TEST_GIT_CLIFF` to a git-cliff 2.14.1 executable to include the native
version-bump and changelog integration test. These tests do not publish releases.

### Prepare and publish

1. Run the **Prepare Release** workflow (Actions tab -> Prepare Release -> Run workflow). It:
   - computes the target version and the **full** notes since the last final release,
   - verifies a `prerelease/vX.Y.Z` branch exists and its tip matches the latest published `vX.Y.Z-rc.N` tag, and that no releasable source changes have landed after that RC (publish the current draft first if needed); ignored commits alone do not require another RC,
   - updates `CHANGELOG.md` and pins the `README.md` usage examples to `vX.Y.Z` (so the default branch docs match the published tag),
   - opens a PR titled `chore(release): vX.Y.Z` with the full notes as its body.
2. Review the PR (notes + `CHANGELOG.md`). Edit the PR body if you want to adjust the published notes. **Merge it** (squash).
3. `publish-release.yml` runs on the merge and:
   - re-pins the `README.md` usage examples on the last RC commit from the RC tag to `vX.Y.Z` (a verified commit that touches only `README.md`; `dist/` is carried over byte-identical),
   - tags `vX.Y.Z` at that commit and marks it `latest`,
   - deletes the `prerelease/vX.Y.Z` and `release-prep/vX.Y.Z` branches.

> The release PR is created by the workflow token, so GitHub does not start `pull_request` workflow runs for it. **Prepare Release** therefore dispatches the **CI** workflow against the `release-prep/vX.Y.Z` branch (`workflow_dispatch` is the one event `GITHUB_TOKEN` is allowed to trigger). Those check runs attach to the branch's head commit - which is the PR's head commit - so the required `Lint`, `Build`, `Type Check` and `Test Check` contexts are satisfied without bypassing the ruleset. `PR Title` still does not run on the release PR; its title is correct by construction, so keep that check out of the required list.

> `release-prep/*` is not a release artifact namespace. It is a short-lived PR integration branch and intentionally descends from `main`; GitHub cannot open a pull request between unrelated histories. The published tag is created from the orphan `prerelease/vX.Y.Z` carrier, never from `release-prep/*`.

## Cleaning up orphaned release branches

`publish-release.yml` deletes `prerelease/vX.Y.Z` and `release-prep/vX.Y.Z` when a final release ships, so between releases there are normally no release branches. These cases are not covered by that on-publish cleanup:

- a `prerelease/vX.Y.Z` cycle **superseded before it shipped** (e.g. a breaking change retargets the computed version `v0.1.0` -> `v1.0.0`, so `v0.1.0` is never published and its branch lingers),
- a `release-prep/vX.Y.Z` branch whose release PR was **closed without merging**, and
- legacy `prerelease/vX.Y.Z-rc.N` branches from an older per-RC design (the current pipeline keeps a single `prerelease/vX.Y.Z` carrier for the whole cycle, so any -rc-suffixed branch is stale - its commit is already preserved by the `vX.Y.Z-rc.N` tag).

The **Cleanup Release Branches** workflow (`cleanup-release-branches.yml`) handles all of them. It runs weekly and on demand, and keeps only the active in-flight branches: the highest-versioned stable-named `prerelease/vX.Y.Z` that is still ahead of the latest published stable release, and any `release-prep/*` backing an open `chore(release): …` PR. Run it from the Actions tab with **dry_run** enabled first to preview deletions.

## Rollback

> Prefer a **forward fix**. Published release tags are immutable and cannot be re-pointed, so the cleanest recovery for a bad release is to ship the next patch.

### The release PR hasn't been merged yet

Close (or delete) the PR; nothing is published until it merges. Re-run **Prepare Release** to regenerate it.

### A bad version was published (forward fix - preferred)

1. Revert the offending change on `main` (`git revert <sha>`), open a PR, merge.
2. Let an RC build, then run **Prepare Release** again to publish the next patch (e.g. `v1.2.3` -> `v1.2.4`). Consumers move forward by bumping the pinned exact version (Dependabot raises that bump automatically).

### Break-glass: stop consumers from getting a bad release

Exact version tags are immutable and cannot be moved, so the only levers are the **Latest** pointer and the release listing. Point **Latest** back at the previous good release and de-list the bad one:

```bash
# restore the "Latest" badge to the previous good release
gh release edit "<prev-version>" --latest

# de-list the bad release (or delete it from the Releases page)
gh release edit "<bad-version>" --draft
```

> **What this does and does not do.** Editing **Latest** and de-listing only change *discoverability* (the badge, the Releases page, and where new adopters land). They do **not** retract anything: the `vX.Y.Z` git tag still resolves, so any workflow already pinned to the bad tag (or its commit SHA) keeps getting it until it is bumped - the Actions ecosystem has no "yank". Deleting the release does not delete the underlying git tag either; delete the tag explicitly if you truly want `@vX.Y.Z` to stop resolving (still a breaking change for pinned consumers, and a locked immutable tag may refuse deletion).

The only real remedy is therefore the forward fix above: ship the next patch. Consumers pinned to the bad exact tag recover by bumping to it (Dependabot raises that bump automatically).

## Notes

- This project publishes only exact, immutable `vX.Y.Z` tags - there are no floating `latest` / `v<major>` / `v<major>.<minor>` aliases to maintain.
- `dist/` is rebuilt in CI and provenance-signed; verify any published artifact with `gh attestation verify dist/index.mjs --repo <owner>/<repo>`.

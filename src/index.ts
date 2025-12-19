import * as core from '@actions/core';
import * as fs from 'fs';

import Git from './git.js';
import { forEach, dedent, addTrailingSlash, pathIsDirectory, copy, remove, arrayEquals } from './helpers.js';
import { parseConfig, default as config } from './config.js';

import type { ModifiedFile, RepoConfig, FileConfig } from './types.js';

const {
  COMMIT_EACH_FILE,
  COMMIT_PREFIX,
  PR_LABELS,
  ASSIGNEES,
  DRY_RUN,
  TMP_DIR,
  SKIP_CLEANUP,
  OVERWRITE_EXISTING_PR,
  SKIP_PR,
  ORIGINAL_MESSAGE,
  COMMIT_AS_PR_TITLE,
  FORK,
  REVIEWERS,
  TEAM_REVIEWERS
} = config;

/**
 * Process a single file sync operation
 */
async function processFile(
  git: Git,
  file: FileConfig,
  modified: ModifiedFile[],
  item: RepoConfig
): Promise<void> {
  const fileExists = fs.existsSync(file.source);
  const localDestination = `${git.workingDir}/${file.dest}`;
  const destExists = fs.existsSync(localDestination);
  let isDirectory: boolean;

  if (!fileExists) {
    // If there is no local file, then we assume it's not a directory
    isDirectory = false;

    if (!file.deleteOrphaned) {
      core.warning(`Source ${file.source} not found`);
      return;
    }

    // Delete orphaned file in destination if it exists
    if (destExists) {
      core.info(`Source ${file.source} not found, removing orphaned file ${file.dest}`);
      await git.remove(file.dest);
    } else {
      core.debug(`Source ${file.source} not found and destination ${file.dest} does not exist`);
      return;
    }
  } else {
    isDirectory = await pathIsDirectory(file.source);

    // For directories, `replace: false` should be handled file-by-file (skip overwriting existing files)
    if (!isDirectory && destExists && file.replace === false) {
      core.warning("File(s) already exist(s) in destination and 'replace' option is set to false");
      return;
    }

    const source = isDirectory ? addTrailingSlash(file.source) : file.source;
    const dest = isDirectory ? addTrailingSlash(localDestination) : localDestination;

    if (isDirectory) {
      core.info('Source is directory');
    }

    await copy(source, dest, isDirectory, file, item);
    await git.add(file.dest);
  }

  // Commit each file separately, if option is set to false commit all files at once later
  if (COMMIT_EACH_FILE) {
    const hasChanges = await git.hasChanges();

    if (!hasChanges) {
      core.debug('File(s) already up to date');
      return;
    }

    core.debug(`Creating commit for file(s) ${file.dest}`);

    // Use different commit/pr message based on if the source is a directory or file
    const directory = isDirectory ? 'directory' : '';
    const otherFiles = isDirectory ? 'and copied all sub files/folders' : '';
    const useOriginalCommitMessage =
      ORIGINAL_MESSAGE &&
      git.isOneCommitPush() &&
      arrayEquals(await git.getChangesFromLastCommit(file.source), await git.changes(file.dest));

    const message = {
      true: {
        commit:
          useOriginalCommitMessage ?
            git.originalCommitMessage()
          : `${COMMIT_PREFIX} synced local '${file.dest}' with remote '${file.source}'`,
        pr: `synced local ${directory} <code>${file.dest}</code> with remote ${directory} <code>${file.source}</code>`
      },
      false: {
        commit:
          useOriginalCommitMessage ?
            git.originalCommitMessage()
          : `${COMMIT_PREFIX} created local '${file.dest}' from remote '${file.source}'`,
        pr: `created local ${directory} <code>${file.dest}</code> ${otherFiles} from remote ${directory} <code>${file.source}</code>`
      }
    };

    const messageKey = String(destExists) as 'true' | 'false';

    // Commit and add file to modified array
    await git.commit(message[messageKey].commit);
    modified.push({
      dest: file.dest,
      source: file.source,
      message: message[messageKey].pr,
      useOriginalMessage: useOriginalCommitMessage,
      commitMessage: message[messageKey].commit
    });
  }
}

/**
 * Process a single repository sync
 */
async function processRepo(git: Git, item: RepoConfig): Promise<string | undefined> {
  core.info('Repository Info');
  core.info(`Target Repo   : ${item.repo.user}/${item.repo.name}`)
  core.info(`Target Url    : https://${item.repo.fullName}`)
  core.info(`Source Branch : ${item.repo.branch}`);
  core.info(`Branch Suffix : ${item.branchSuffix || 'n/a'}`);
  core.info(' ');

  try {
    // Clone and setup the git repository locally
    await git.initRepo(item.repo, item.branchSuffix);

    let existingPr: Awaited<ReturnType<typeof git.findExistingPr>> | undefined;

    if (!SKIP_PR) {
      await git.createPrBranch(item.branchSuffix);

      // Check for existing PR and add warning message
      existingPr = OVERWRITE_EXISTING_PR ? await git.findExistingPr() : undefined;

      if (existingPr && !DRY_RUN) {
        core.info(`Found existing PR ${existingPr.number}`);
        await git.setPrWarning();
      }
    }

    core.info('Locally syncing file(s) between source and target repository');
    const modified: ModifiedFile[] = [];

    // Loop through all selected files of the source repo
    await forEach(item.files, async (file) => {
      await processFile(git, file, modified, item);
    });

    if (DRY_RUN) {
      core.warning('Dry run, no changes will be pushed');
      core.debug('Git Status:');
      core.debug(await git.status());
      return undefined;
    }

    const hasChanges = await git.hasChanges();

    // If no changes left and nothing was modified, nothing has changed
    if (!hasChanges && modified.length < 1) {
      core.info('File(s) already up to date');

      if (existingPr) {
        await git.removePrWarning();
      }

      return undefined;
    }

    // If there are still local changes left, commit them before pushing
    if (hasChanges) {
      core.debug('Creating commit for remaining files');

      let useOriginalCommitMessage = ORIGINAL_MESSAGE && git.isOneCommitPush();

      if (useOriginalCommitMessage) {
        await forEach(item.files, async (file) => {
          useOriginalCommitMessage =
            useOriginalCommitMessage &&
            arrayEquals(await git.getChangesFromLastCommit(file.source), await git.changes(file.dest));
        });
      }

      const commitMessage = useOriginalCommitMessage ? git.originalCommitMessage() : undefined;

      await git.commit(commitMessage);
      modified.push({
        dest: git.workingDir,
        source: undefined,
        message: undefined,
        useOriginalMessage: useOriginalCommitMessage,
        commitMessage
      });
    }

    core.info('Pushing changes to target repository');
    await git.push();

    if (!SKIP_PR) {
      // If each file was committed separately, list them in the PR description
      const changedFiles = dedent`
        <details>
        <summary>Changed files</summary>
        <ul>
        ${modified.map((file) => `<li>${file.message}</li>`).join('')}
        </ul>
        </details>
      `;

      const firstModified = modified[0];
      const useCommitAsPRTitle =
        COMMIT_AS_PR_TITLE && modified.length === 1 && firstModified?.useOriginalMessage === true;

      const prTitle = useCommitAsPRTitle ? firstModified?.commitMessage?.split('\n', 1)[0]?.trim() : undefined;

      const pullRequest = await git.createOrUpdatePr(COMMIT_EACH_FILE ? changedFiles : '', prTitle);

      core.notice(`Pull Request #${pullRequest.number} created/updated: ${pullRequest.html_url}`);

      if (PR_LABELS && PR_LABELS.length > 0 && !FORK) {
        core.info(`Adding label(s) "${PR_LABELS.join(', ')}" to PR`);
        await git.addPrLabels(PR_LABELS);
      }

      if (ASSIGNEES && ASSIGNEES.length > 0 && !FORK) {
        core.info(`Adding assignee(s) "${ASSIGNEES.join(', ')}" to PR`);
        await git.addPrAssignees(ASSIGNEES);
      }

      const itemReviewers = item.reviewers ?? REVIEWERS;
      if (itemReviewers && itemReviewers.length > 0 && !FORK) {
        core.info(`Adding reviewer(s) "${itemReviewers.join(', ')}" to PR`);
        await git.addPrReviewers(itemReviewers);
      }

      if (TEAM_REVIEWERS && TEAM_REVIEWERS.length > 0 && !FORK) {
        core.info(`Adding team reviewer(s) "${TEAM_REVIEWERS.join(', ')}" to PR`);
        await git.addPrTeamReviewers(TEAM_REVIEWERS);
      }

      return pullRequest.html_url;
    }

    core.info('	');
    return undefined;
  } catch (err) {
    const error = err as Error;
    core.setFailed(error.message);
    core.debug(String(err));
    return undefined;
  } finally {
    // Cleanup working directory for this repo
    await git.cleanupRepo(item.repo, !SKIP_CLEANUP);
  }
}

/**
 * Main entry point
 */
async function run(): Promise<void> {
  // Reuse octokit for each repo
  const git = new Git();

  const repos = await parseConfig();
  const prUrls: string[] = [];

  await forEach(repos, async (item) => {
    const prUrl = await processRepo(git, item);
    if (prUrl) {
      prUrls.push(prUrl);
    }
  });

  // If we created any PRs, set their URLs as the output
  if (prUrls.length > 0) {
    core.setOutput('pull_request_urls', prUrls);
  }

  if (SKIP_CLEANUP) {
    core.info('Skipping cleanup');
    return;
  }

  await remove(TMP_DIR);
  core.info('Cleanup complete');
}

run().catch((err: Error) => {
  core.setFailed(err.message);
  core.debug(String(err));
});

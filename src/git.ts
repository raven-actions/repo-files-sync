import * as core from '@actions/core';
import * as github from '@actions/github';
import { GitHub, getOctokitOptions } from '@actions/github/lib/utils.js';
import { throttling } from '@octokit/plugin-throttling';
import * as path from 'path';

import config from './config.js';
import { dedent, execCmd, remove } from './helpers.js';

import type { RepoInfo, TreeDiffEntry, GitDiffDict } from './types.js';

// Pull request type from GitHub API (simplified for our use case)
interface PullRequestInfo {
  number: number;
  html_url: string;
  body: string | null;
}

// Git tree entry type for GitHub API
type GitTreeMode = '100644' | '100755' | '040000' | '160000' | '120000';

interface GitHubTreeEntry {
  path?: string;
  mode?: GitTreeMode;
  type?: 'blob' | 'tree' | 'commit';
  sha?: string | null;
  content?: string;
}

const {
  GITHUB_TOKEN,
  GITHUB_SERVER_URL,
  IS_INSTALLATION_TOKEN,
  IS_FINE_GRAINED,
  GIT_USERNAME,
  GIT_EMAIL,
  TMP_DIR,
  COMMIT_BODY,
  COMMIT_PREFIX,
  GITHUB_REPOSITORY,
  OVERWRITE_EXISTING_PR,
  SKIP_PR,
  PR_BODY,
  BRANCH_PREFIX,
  FORK
} = config;

export default class Git {
  private github: InstanceType<typeof GitHub>['rest'];
  private repo!: RepoInfo;
  private existingPr: PullRequestInfo | undefined;
  private prBranch: string | undefined;
  private baseBranch!: string;
  private gitUrl!: string;
  private lastCommitSha!: string;
  private lastCommitChanges: GitDiffDict | undefined;
  public workingDir!: string;

  constructor() {
    // Cast throttling to handle version mismatch between @actions/github and @octokit/plugin-throttling
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Octokit = GitHub.plugin(throttling as any);

    const options = getOctokitOptions(GITHUB_TOKEN, {
      baseUrl: process.env['GITHUB_API_URL'] || 'https://api.github.com',
      throttle: {
        onRateLimit: (retryAfter: number) => {
          core.debug(`Hit GitHub API rate limit, retrying after ${retryAfter}s`);
          return true;
        },
        onSecondaryRateLimit: (retryAfter: number) => {
          core.debug(`Hit secondary GitHub API rate limit, retrying after ${retryAfter}s`);
          return true;
        }
      }
    });

    const octokit = new Octokit(options);
    this.github = octokit.rest;
  }

  async initRepo(repo: RepoInfo): Promise<void> {
    // Reset repo specific values
    this.existingPr = undefined;
    this.prBranch = undefined;

    // Set values to current repo
    this.repo = repo;
    this.workingDir = path.join(TMP_DIR, repo.uniqueName);
    this.gitUrl = `https://${IS_INSTALLATION_TOKEN ? 'x-access-token:' : ''}${
      IS_FINE_GRAINED ? 'oauth:' : ''
    }${GITHUB_TOKEN}@${repo.fullName}.git`;

    await this.clone();
    await this.setIdentity();
    await this.getBaseBranch();
    await this.getLastCommitSha();

    if (FORK) {
      const forkUrl = new URL(GITHUB_SERVER_URL);
      forkUrl.username = GITHUB_TOKEN;
      forkUrl.pathname = `${FORK}/${this.repo.name}.git`;
      await this.createFork();
      await this.createRemote(forkUrl.toString());
    }
  }

  async createFork(): Promise<void> {
    core.debug(`Creating fork with OWNER: ${this.repo.user} and REPO: ${this.repo.name}`);
    await this.github.repos.createFork({
      owner: this.repo.user,
      repo: this.repo.name
    });
  }

  async createRemote(forkUrl: string): Promise<string> {
    return execCmd(`git remote add fork ${forkUrl}`, this.workingDir);
  }

  async clone(): Promise<string> {
    core.debug(`Cloning ${this.repo.fullName} into ${this.workingDir}`);

    const branchOption = this.repo.branch !== 'default' ? `--branch "${this.repo.branch}"` : '';

    return execCmd(`git clone --depth 1 ${branchOption} ${this.gitUrl} ${this.workingDir}`);
  }

  async setIdentity(): Promise<string> {
    let username = GIT_USERNAME;
    let email = GIT_EMAIL;

    if (email === undefined) {
      if (!IS_INSTALLATION_TOKEN) {
        const { data } = await this.github.users.getAuthenticated();
        email = data.email ?? undefined;
        username = data.login;
      }
    }

    core.debug(`Setting git user to email: ${email}, username: ${username}`);

    return execCmd(
      `git config --local user.name "${username}" && git config --local user.email "${email}"`,
      this.workingDir
    );
  }

  async getBaseBranch(): Promise<void> {
    this.baseBranch = await execCmd(`git rev-parse --abbrev-ref HEAD`, this.workingDir);
  }

  async createPrBranch(branchSuffix = ''): Promise<void> {
    const repoName = GITHUB_REPOSITORY.split('/')[1] ?? '';
    const prefix = BRANCH_PREFIX.replace('SOURCE_REPO_NAME', repoName);

    let newBranch = path.join(prefix, this.repo.branch).replace(/\\/g, '/').replace(/\/\./g, '/');
    newBranch += branchSuffix ? `-${branchSuffix}` : '';

    this.prBranch = newBranch;

    if (OVERWRITE_EXISTING_PR === false) {
      newBranch += `-${Math.round(new Date().getTime() / 1000)}`;
      this.prBranch = newBranch;

      core.debug(`Creating PR Branch ${newBranch}`);

      await execCmd(`git switch -c "${newBranch}"`, this.workingDir);
      return;
    }

    core.debug(`Switch/Create PR Branch ${newBranch}`);

    // Fetch all branches
    await execCmd(`git remote set-branches origin '*'`, this.workingDir);
    await execCmd(`git fetch -v --depth=1`, this.workingDir);

    // Use git switch to create or switch to branch
    await execCmd(`git switch "${newBranch}" 2>/dev/null || git switch -c "${newBranch}"`, this.workingDir);

    await this.getLastCommitSha();
  }

  async add(file: string): Promise<string> {
    return execCmd(`git add -f "${file}"`, this.workingDir);
  }

  async remove(file: string): Promise<string> {
    return execCmd(`git rm -f "${file}"`, this.workingDir);
  }

  async cleanupRepo(repo: RepoInfo): Promise<void> {
    core.debug(`Cleaning up repo ${repo.fullName}`);

    // Remove the working directory
    if (this.workingDir) {
      await remove(this.workingDir);
    }

    // Reset repo-specific values
    this.existingPr = undefined;
    this.prBranch = undefined;
    this.lastCommitChanges = undefined;
  }

  isOneCommitPush(): boolean {
    const commits = github.context.payload['commits'] as unknown[] | undefined;
    return github.context.eventName === 'push' && commits?.length === 1;
  }

  originalCommitMessage(): string {
    const commits = github.context.payload['commits'] as Array<{ message?: string }> | undefined;
    return commits?.[0]?.message ?? '';
  }

  /**
   * Parses git diff output and returns a dictionary mapping file paths to their diffs
   */
  parseGitDiffOutput(diffString: string): GitDiffDict {
    // Split diff into separate entries for separate files
    return `\n${diffString}`
      .split('\ndiff --git')
      .slice(1)
      .reduce((resultDict: GitDiffDict, fileDiff) => {
        const lines = fileDiff.split('\n');
        const lastHeaderLineIndex = lines.findIndex((line) => line.startsWith('+++'));

        if (lastHeaderLineIndex === -1) {
          return resultDict; // ignore binary files
        }

        const plainDiff = lines
          .slice(lastHeaderLineIndex + 1)
          .join('\n')
          .trim();

        let filePath = '';
        const headerLine = lines[lastHeaderLineIndex];
        const prevHeaderLine = lines[lastHeaderLineIndex - 1];

        if (headerLine?.startsWith('+++ b/')) {
          // Every file except removed files
          filePath = headerLine.slice(6); // remove '+++ b/'
        } else if (prevHeaderLine) {
          // For removed files, use header line with filename before deletion
          filePath = prevHeaderLine.slice(6); // remove '--- a/'
        }

        return { ...resultDict, [filePath]: plainDiff };
      }, {});
  }

  /**
   * Gets array of git diffs for the source, which can be a file or directory
   */
  async getChangesFromLastCommit(source: string): Promise<string[]> {
    if (this.lastCommitChanges === undefined) {
      const diff = await this.github.repos.compareCommits({
        mediaType: {
          format: 'diff'
        },
        owner: github.context.payload.repository?.owner?.name ?? '',
        repo: github.context.payload.repository?.name ?? '',
        base: github.context.payload['before'] as string,
        head: github.context.payload['after'] as string
      });

      this.lastCommitChanges = this.parseGitDiffOutput(diff.data as unknown as string);
    }

    if (source.endsWith('/')) {
      return Object.keys(this.lastCommitChanges)
        .filter((filePath) => filePath.startsWith(source))
        .map((key) => this.lastCommitChanges?.[key] ?? '')
        .filter((diff) => diff !== '');
    }

    const change = this.lastCommitChanges[source];
    return change !== undefined ? [change] : [];
  }

  async getLastCommitSha(): Promise<void> {
    this.lastCommitSha = await execCmd(`git rev-parse HEAD`, this.workingDir);
  }

  /**
   * Gets array of git diffs for the destination, which can be a file or directory
   */
  async changes(destination: string): Promise<string[]> {
    const output = await execCmd(`git diff HEAD ${destination}`, this.workingDir);
    return Object.values(this.parseGitDiffOutput(output));
  }

  async hasChanges(): Promise<boolean> {
    const statusOutput = await execCmd(`git status --porcelain`, this.workingDir);
    // Non-empty output means there are changes
    return statusOutput.trim().length > 0;
  }

  async commit(msg?: string): Promise<string> {
    let message = msg ?? `${COMMIT_PREFIX} synced file(s) with ${GITHUB_REPOSITORY}`;

    if (COMMIT_BODY) {
      message += `\n\n${COMMIT_BODY}`;
    }

    return execCmd(`git commit -m '${message.replace(/'/g, "'\\''")}'`, this.workingDir);
  }

  /**
   * Returns a git tree parsed for the specified commit sha
   */
  async getTreeId(commitSha: string): Promise<string> {
    core.debug(`Getting treeId for commit ${commitSha}`);

    const output = (await execCmd(`git cat-file -p ${commitSha}`, this.workingDir)).split('\n');

    const commitHeaders = output.slice(
      0,
      output.findIndex((e) => e === '')
    );
    const tree = commitHeaders.find((e) => e.startsWith('tree'))?.replace('tree ', '');

    return tree ?? '';
  }

  async getTreeDiff(referenceTreeId: string, differenceTreeId: string): Promise<TreeDiffEntry[]> {
    const output = await execCmd(`git diff-tree ${referenceTreeId} ${differenceTreeId} -r`, this.workingDir);

    const diff: TreeDiffEntry[] = [];

    for (const line of output.split('\n')) {
      const splitted = line.replace(/^:/, '').replace('\t', ' ').split(' ');

      const newMode = splitted[0] ?? '';
      const previousMode = splitted[1] ?? '';
      const newBlob = splitted[2] ?? '';
      const previousBlob = splitted[3] ?? '';
      const change = splitted[4] ?? '';
      const filePath = splitted[5] ?? '';

      diff.push({
        newMode,
        previousMode,
        newBlob,
        previousBlob,
        change,
        path: filePath
      });
    }

    return diff;
  }

  /**
   * Creates the blob objects in GitHub for files not in the previous commit
   */
  async uploadGitHubBlob(blob: string): Promise<void> {
    core.debug(`Uploading GitHub Blob for blob ${blob}`);

    const fileContent = await execCmd(`git cat-file -p ${blob}`, this.workingDir, false);

    await this.github.git.createBlob({
      owner: this.repo.user,
      repo: this.repo.name,
      content: Buffer.from(fileContent).toString('base64'),
      encoding: 'base64'
    });
  }

  /**
   * Gets the commit list in chronological order
   */
  async getCommitsToPush(): Promise<string[]> {
    const output = await execCmd(
      `git log --format=%H --reverse ${SKIP_PR === false ? '' : 'origin/'}${this.baseBranch}..HEAD`,
      this.workingDir
    );

    return output.split('\n');
  }

  async getCommitMessage(commitSha: string): Promise<string> {
    return execCmd(`git log -1 --format=%B ${commitSha}`, this.workingDir);
  }

  /**
   * Runs the complete flow to generate pending commits using the GitHub API
   */
  async createGithubVerifiedCommits(): Promise<void> {
    core.debug('Creating Commits using GitHub API');

    const commits = await this.getCommitsToPush();

    if (SKIP_PR === false) {
      // Creates the PR branch if it doesn't exist
      try {
        await this.github.git.createRef({
          owner: this.repo.user,
          repo: this.repo.name,
          sha: this.lastCommitSha,
          ref: 'refs/heads/' + this.prBranch
        });

        core.debug(`Created new branch ${this.prBranch}`);
      } catch (error) {
        const err = error as Error;
        if (err.message !== 'Reference already exists') {
          throw error;
        }
      }
    }

    for (const commit of commits) {
      await this.createGithubCommit(commit);
    }

    core.debug(`Updating branch ${SKIP_PR === false ? this.prBranch : this.baseBranch} ref`);

    await this.github.git.updateRef({
      owner: this.repo.user,
      repo: this.repo.name,
      ref: `heads/${SKIP_PR === false ? this.prBranch : this.baseBranch}`,
      sha: this.lastCommitSha,
      force: true
    });

    core.debug('Commit using GitHub API completed');
  }

  async status(): Promise<string> {
    return execCmd('git status', this.workingDir);
  }

  async push(): Promise<string | void> {
    if (FORK) {
      return execCmd(`git push -u fork ${this.prBranch} --force`, this.workingDir);
    }

    if (IS_INSTALLATION_TOKEN) {
      return this.createGithubVerifiedCommits();
    }

    return execCmd(`git push ${this.gitUrl} --force`, this.workingDir);
  }

  async findExistingPr(): Promise<PullRequestInfo | undefined> {
    const { data } = await this.github.pulls.list({
      owner: this.repo.user,
      repo: this.repo.name,
      state: 'open',
      head: `${FORK ? FORK : this.repo.user}:${this.prBranch}`
    });

    const pr = data[0];
    if (pr) {
      this.existingPr = {
        number: pr.number,
        html_url: pr.html_url,
        body: pr.body
      };
    }
    return this.existingPr;
  }

  async setPrWarning(): Promise<void> {
    if (!this.existingPr) return;

    await this.github.pulls.update({
      owner: this.repo.user,
      repo: this.repo.name,
      pull_number: this.existingPr.number,
      body: dedent`
        ⚠️ This PR is being automatically resynced ⚠️

        ${this.existingPr.body ?? ''}
      `
    });
  }

  async removePrWarning(): Promise<void> {
    if (!this.existingPr) return;

    await this.github.pulls.update({
      owner: this.repo.user,
      repo: this.repo.name,
      pull_number: this.existingPr.number,
      body: (this.existingPr.body ?? '').replace('⚠️ This PR is being automatically resynced ⚠️', '')
    });
  }

  async createOrUpdatePr(changedFiles: string, title?: string): Promise<PullRequestInfo> {
    const body = dedent`
      synced local file(s) with [${GITHUB_REPOSITORY}](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}).

      ${PR_BODY}

      ${changedFiles}

      ---

      This PR was created automatically by the [repo-files-sync-action](https://github.com/raven-actions/repo-files-sync) workflow run [#${
        process.env['GITHUB_RUN_ID'] || 0
      }](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${process.env['GITHUB_RUN_ID'] || 0})
    `;

    if (this.existingPr) {
      core.info('Overwriting existing PR');

      const { data } = await this.github.pulls.update({
        owner: this.repo.user,
        repo: this.repo.name,
        title: `${COMMIT_PREFIX} synced file(s) with ${GITHUB_REPOSITORY}`,
        pull_number: this.existingPr.number,
        body
      });

      this.existingPr = {
        number: data.number,
        html_url: data.html_url,
        body: data.body
      };
      return this.existingPr;
    }

    core.info('Creating new PR');

    const { data } = await this.github.pulls.create({
      owner: this.repo.user,
      repo: this.repo.name,
      title: title ?? `${COMMIT_PREFIX} synced file(s) with ${GITHUB_REPOSITORY}`,
      body,
      head: `${FORK ? FORK : this.repo.user}:${this.prBranch}`,
      base: this.baseBranch
    });

    this.existingPr = {
      number: data.number,
      html_url: data.html_url,
      body: data.body
    };
    return this.existingPr;
  }

  async addPrLabels(labels: string[]): Promise<void> {
    if (!this.existingPr) return;

    await this.github.issues.addLabels({
      owner: this.repo.user,
      repo: this.repo.name,
      issue_number: this.existingPr.number,
      labels
    });
  }

  async addPrAssignees(assignees: string[]): Promise<void> {
    if (!this.existingPr) return;

    await this.github.issues.addAssignees({
      owner: this.repo.user,
      repo: this.repo.name,
      issue_number: this.existingPr.number,
      assignees
    });
  }

  async addPrReviewers(reviewers: string[]): Promise<void> {
    if (!this.existingPr) return;

    await this.github.pulls.requestReviewers({
      owner: this.repo.user,
      repo: this.repo.name,
      pull_number: this.existingPr.number,
      reviewers
    });
  }

  async addPrTeamReviewers(reviewers: string[]): Promise<void> {
    if (!this.existingPr) return;

    await this.github.pulls.requestReviewers({
      owner: this.repo.user,
      repo: this.repo.name,
      pull_number: this.existingPr.number,
      team_reviewers: reviewers
    });
  }

  async createGithubCommit(commitSha: string): Promise<void> {
    const [
      treeId,
      parentTreeId,
      commitMessage
    ] = await Promise.all([
      this.getTreeId(commitSha),
      this.getTreeId(`${commitSha}~1`),
      this.getCommitMessage(commitSha)
    ]);

    const treeDiff = await this.getTreeDiff(treeId, parentTreeId);

    core.debug('Uploading the blobs to GitHub');

    const blobsToCreate = treeDiff.filter(
      (e): e is TreeDiffEntry & { newBlob: string } => e.newMode !== '000000' && e.newBlob !== null
    );

    await Promise.all(blobsToCreate.map((e) => this.uploadGitHubBlob(e.newBlob)));

    core.debug('Creating a GitHub tree');

    const tree: GitHubTreeEntry[] = treeDiff.map((e) => {
      let mode = e.newMode;
      let sha: string | null = e.newBlob;

      if (e.newMode === '000000') {
        // Set the sha to null to remove the file
        mode = e.previousMode;
        sha = null;
      }

      return {
        path: e.path,
        mode: mode as GitTreeMode,
        type: 'blob' as const,
        sha
      };
    });

    let treeSha: string;

    try {
      const request = await this.github.git.createTree({
        owner: this.repo.user,
        repo: this.repo.name,
        tree,
        base_tree: parentTreeId
      });
      treeSha = request.data.sha;
    } catch (error) {
      const err = error as Error;
      err.message = `Cannot create a new GitHub Tree: ${err.message}`;
      throw err;
    }

    core.debug('Creating a commit for the GitHub tree');

    const request = await this.github.git.createCommit({
      owner: this.repo.user,
      repo: this.repo.name,
      message: commitMessage,
      parents: [this.lastCommitSha],
      tree: treeSha
    });

    this.lastCommitSha = request.data.sha;
  }
}

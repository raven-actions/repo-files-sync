import * as core from '@actions/core';
import { Ajv } from 'ajv/dist/ajv.js';
import * as yaml from 'js-yaml';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

import { getInput, getBooleanInput, getArrayInput, getOptionalInput, getDisableableInput, getDisableableArrayInput } from './input.js';
import type { ConfigContext, RepoInfo, FileConfig, RepoConfig, RawFileConfig, GroupConfig } from './types.js';

// Default values
const REPLACE_DEFAULT = true;
const TEMPLATE_DEFAULT = false;

/**
 * Initialize and validate configuration context
 */
function initializeContext(): ConfigContext {
  const token = getInput('GH_TOKEN');

  if (!token) {
    core.setFailed('You must provide GH_TOKEN');
    process.exit(1);
  }

  // A single GH_TOKEN serves both flows; the type is inferred from its documented
  // prefix (https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/):
  //   ghs_        GitHub App installation token -> commits are created through the
  //               GitHub API (verified) over the x-access-token git scheme, and
  //               GIT_EMAIL/GIT_USERNAME are required.
  //   github_pat_ fine-grained PAT -> authenticated over the oauth git scheme.
  // Anything else is treated as a classic PAT.
  const isInstallationToken = token.startsWith('ghs_');

  const context: ConfigContext = {
    GITHUB_TOKEN: token,
    GITHUB_SERVER_URL: process.env['GITHUB_SERVER_URL'] || 'https://github.com',
    IS_INSTALLATION_TOKEN: isInstallationToken,
    GIT_EMAIL: getInput('GIT_EMAIL') || undefined,
    GIT_USERNAME: getInput('GIT_USERNAME') || undefined,
    CONFIG_PATH: getOptionalInput('CONFIG_PATH', '.github/sync.yml'),
    INLINE_CONFIG: getOptionalInput('INLINE_CONFIG', ''),
    REPOS: getArrayInput('REPOS'),
    IS_FINE_GRAINED: token.startsWith('github_pat_'),
    COMMIT_BODY: getOptionalInput('COMMIT_BODY', ''),
    COMMIT_PREFIX: getOptionalInput('COMMIT_PREFIX', '🔄'),
    COMMIT_EACH_FILE: getBooleanInput('COMMIT_EACH_FILE', true),
    PR_LABELS: getDisableableArrayInput('PR_LABELS', ['sync']),
    PR_TITLE: getOptionalInput('PR_TITLE', ''),
    PR_BODY: getOptionalInput('PR_BODY', ''),
    ASSIGNEES: getArrayInput('ASSIGNEES'),
    REVIEWERS: getArrayInput('REVIEWERS'),
    TEAM_REVIEWERS: getArrayInput('TEAM_REVIEWERS'),
    TMP_DIR: getOptionalInput('TMP_DIR', `tmp-${Date.now().toString()}`),
    DRY_RUN: getBooleanInput('DRY_RUN', false),
    SKIP_CLEANUP: getBooleanInput('SKIP_CLEANUP', false),
    OVERWRITE_EXISTING_PR: getBooleanInput('OVERWRITE_EXISTING_PR', true),
    REBASE: getBooleanInput('REBASE', false),
    GITHUB_REPOSITORY: process.env['GITHUB_REPOSITORY'] || '',
    SKIP_PR: getBooleanInput('SKIP_PR', false),
    ORIGINAL_MESSAGE: getBooleanInput('ORIGINAL_MESSAGE', false),
    COMMIT_AS_PR_TITLE: getBooleanInput('COMMIT_AS_PR_TITLE', false),
    DELETE_ORPHANED: getBooleanInput('DELETE_ORPHANED', false),
    BRANCH_PREFIX: getOptionalInput('BRANCH_PREFIX', 'repo-sync/SOURCE_REPO_NAME'),
    FORK: getDisableableInput('FORK', false)
  };

  core.setSecret(context.GITHUB_TOKEN);
  core.debug(JSON.stringify(context, null, 2));

  // REBASE only applies to the reuse-an-existing-PR flow. Warn when it is
  // combined with options that bypass that flow so it has no silent surprises.
  if (context.REBASE && context.SKIP_PR) {
    core.warning(
      'REBASE has no effect when SKIP_PR is true: changes are pushed directly to the base branch without a pull request.'
    );
  } else if (context.REBASE && !context.OVERWRITE_EXISTING_PR) {
    core.warning(
      'REBASE has no effect when OVERWRITE_EXISTING_PR is false: a new branch is created from the base branch on every run.'
    );
  }

  // Ensure TMP_DIR is unique
  while (fs.existsSync(context.TMP_DIR)) {
    context.TMP_DIR = `tmp-${Date.now().toString()}`;
    core.warning(`TEMP_DIR already exists. Using "${context.TMP_DIR}" now.`);
  }

  return context;
}

// Initialize context - will exit process if configuration is invalid
let context: ConfigContext;

try {
  context = initializeContext();
} catch (err) {
  const error = err as Error;
  core.setFailed(error.message);
  process.exit(1);
}

/**
 * Parse a repository name string into a RepoInfo object
 */
function parseRepoName(fullRepo: string): RepoInfo {
  const serverHost = new URL(context.GITHUB_SERVER_URL).host;
  let host = serverHost;
  let repoPath = fullRepo;

  if (fullRepo.startsWith('http')) {
    const url = new URL(fullRepo);
    host = url.host;

    if (host.toLowerCase() !== serverHost.toLowerCase()) {
      throw new Error(
        `Target host "${host}" does not match GITHUB_SERVER_URL host "${serverHost}"; cross-host sync is not supported`
      );
    }

    repoPath = url.pathname.replace(/^\/+/, ''); // Remove leading slash
    core.info('Using custom host');
  }

  const parts = repoPath.split('/');
  const user = parts[0] ?? '';
  const nameWithBranch = parts[1] ?? '';
  const name = nameWithBranch.split('@')[0] ?? '';
  const branch = repoPath.split('@')[1] || 'default';

  return {
    url: `https://${host}/${user}/${name}`,
    fullName: `${host}/${user}/${name}`,
    uniqueName: `${host}/${user}/${name}@${branch}`,
    host,
    user,
    name,
    branch
  };
}

/**
 * Parse glob patterns from a newline-separated string
 */
function parsePatterns(text: string | undefined, src: string): string[] | undefined {
  if (text === undefined || typeof text !== 'string') {
    return undefined;
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const normalized = line.replace(/\\/g, '/');
      const srcNormalized = src.replace(/\\/g, '/').replace(/\/+$/, '');

      if (normalized.startsWith(`${srcNormalized}/`)) {
        return normalized.slice(srcNormalized.length + 1);
      }

      return normalized;
    });
}

/**
 * Parse file configurations from YAML
 */
function parseFiles(files: (string | RawFileConfig)[]): FileConfig[] {
  return files
    .map((item): FileConfig | undefined => {
      const fileItem: RawFileConfig = typeof item === 'string' ? { source: item } : item;

      if (fileItem.source !== undefined) {
        const deleteOrphaned = fileItem.deleteOrphaned ?? context.DELETE_ORPHANED;
        const includePatterns = parsePatterns(fileItem.include, fileItem.source);
        const exclude = parsePatterns(fileItem.exclude, fileItem.source);

        return {
          source: fileItem.source,
          dest: fileItem.dest || fileItem.source,
          template: fileItem.template === undefined ? TEMPLATE_DEFAULT : fileItem.template,
          replace: fileItem.replace === undefined ? REPLACE_DEFAULT : fileItem.replace,
          deleteOrphaned,
          exclude,
          include: includePatterns
        };
      }

      core.warning('Warn: No source files specified');
      return undefined;
    })
    .filter((file): file is FileConfig => file !== undefined);
}

/**
 * YAML configuration object type
 */
type YamlConfig = Record<string, (string | RawFileConfig)[] | GroupConfig | GroupConfig[]>;

const schemaPath = fileURLToPath(new URL('../sync.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
const ajv = new Ajv({ allErrors: true, strict: false });
const validateConfig = ajv.compile<YamlConfig>(schema);

function assertValidConfig(configObject: unknown): asserts configObject is YamlConfig {
  if (!validateConfig(configObject)) {
    throw new Error(
      `Invalid sync configuration: ${ajv.errorsText(validateConfig.errors, {
        dataVar: 'configuration',
        separator: '; '
      })}`
    );
  }
}

function loadConfigDocument(content: string): unknown {
  try {
    return yaml.load(content);
  } catch (error) {
    throw new Error(`Invalid sync configuration: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Build the identifiers a repo can be matched by when filtering with REPOS.
 * Supports `owner/name`, `owner/name@branch`, and the host-qualified forms.
 */
function repoFilterCandidates(repo: RepoInfo): string[] {
  return [`${repo.user}/${repo.name}`, `${repo.user}/${repo.name}@${repo.branch}`, repo.fullName, repo.uniqueName].map((value) =>
    value.toLowerCase()
  );
}

/**
 * Restrict the parsed repos to the ones requested via the REPOS input, keeping
 * the original config order. This is purely a repository filter: the file
 * configuration still comes from the existing config. Requested names that do
 * not match any configured repo are ignored (no error), and an empty input
 * disables the filter so every repo is processed.
 */
function filterRepos(repos: RepoConfig[]): RepoConfig[] {
  const tokens = [...new Set((context.REPOS ?? []).map((token) => token.trim().toLowerCase()).filter((token) => token.length > 0))];

  if (tokens.length === 0) {
    return repos;
  }

  core.info(`Limiting sync to requested repo(s): ${tokens.join(', ')}`);

  const matchedTokens = new Set<string>();
  const filtered = repos.filter((item) => {
    const candidates = repoFilterCandidates(item.repo);
    const hits = tokens.filter((token) => candidates.includes(token));
    hits.forEach((token) => matchedTokens.add(token));
    return hits.length > 0;
  });

  // Surface requested names that matched nothing, but never fail the run.
  const unmatched = tokens.filter((token) => !matchedTokens.has(token));
  if (unmatched.length > 0) {
    core.warning(`Requested repo(s) not found in the config (ignored): ${unmatched.join(', ')}`);
  }

  if (filtered.length === 0) {
    core.warning('No repos matched the requested filter; nothing to sync.');
  } else {
    core.info(`Matched ${filtered.length} repo(s): ${filtered.map((item) => `${item.repo.user}/${item.repo.name}`).join(', ')}`);
  }

  return filtered;
}

/**
 * Parse the sync configuration file and return an array of RepoConfig objects
 */
export async function parseConfig(): Promise<RepoConfig[]> {
  let configObject: unknown;

  if (context.INLINE_CONFIG) {
    configObject = loadConfigDocument(context.INLINE_CONFIG);
  } else {
    const fileContent = await fs.promises.readFile(context.CONFIG_PATH);
    configObject = loadConfigDocument(fileContent.toString());
  }

  assertValidConfig(configObject);

  const result: Record<string, RepoConfig> = {};

  // Merge a repo entry into the result so that a given target is only processed
  // once with every related config combined. The identity is the repo's
  // uniqueName (host/user/name@branch) plus the branchSuffix, because a
  // different suffix intentionally targets a different branch/PR. The same key
  // shape is used for both `group` and top-level entries so a repo that appears
  // across multiple groups - or in a mix of groups and top-level keys - is
  // always deduplicated (otherwise it would be cloned to the same working
  // directory and pushed to the same branch twice).
  const mergeRepo = (repo: RepoInfo, files: FileConfig[], branchSuffix: string, reviewers?: string[]): void => {
    const resultKey = `${repo.uniqueName}|${branchSuffix}`;
    const existing = result[resultKey];

    if (existing !== undefined) {
      existing.files.push(...files);

      if (reviewers && reviewers.length > 0) {
        existing.reviewers = [...new Set([...(existing.reviewers ?? []), ...reviewers])];
      }
      return;
    }

    const repoConfig: RepoConfig = { repo, files, branchSuffix };
    if (reviewers && reviewers.length > 0) {
      repoConfig.reviewers = [...reviewers];
    }
    result[resultKey] = repoConfig;
  };

  Object.keys(configObject).forEach((key) => {
    if (key === 'group') {
      const rawObject = configObject[key] as unknown as GroupConfig | GroupConfig[];
      const groups = Array.isArray(rawObject) ? rawObject : [rawObject];

      groups.forEach((group) => {
        const repos =
          typeof group.repos === 'string' ?
            group.repos
              .split('\n')
              .map((n) => n.trim())
              .filter((n) => n)
          : group.repos;

        const branchSuffix = group.branchSuffix || '';

        repos.forEach((name) => {
          mergeRepo(parseRepoName(name), parseFiles(group.files), branchSuffix, group.reviewers);
        });
      });
    } else {
      mergeRepo(parseRepoName(key), parseFiles(configObject[key] as (string | RawFileConfig)[]), '');
    }
  });

  return filterRepos(Object.values(result));
}

export default context;

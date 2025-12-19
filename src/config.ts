import * as core from '@actions/core';
import * as yaml from 'js-yaml';
import fs from 'fs-extra';

import { getInput, getBooleanInput, getArrayInput, getOptionalInput, getDisableableInput, getDisableableArrayInput } from './input.js';
import type { ConfigContext, RepoInfo, FileConfig, RepoConfig } from './types.js';

// Default values
const REPLACE_DEFAULT = true;
const TEMPLATE_DEFAULT = false;

/**
 * Initialize and validate configuration context
 */
function initializeContext(): ConfigContext {
  let isInstallationToken = false;
  let token = getInput('GH_PAT');

  if (!token) {
    token = getInput('GH_INSTALLATION_TOKEN');
    isInstallationToken = true;

    if (!token) {
      core.setFailed('You must provide either GH_PAT or GH_INSTALLATION_TOKEN');
      process.exit(1);
    }
  }

  const context: ConfigContext = {
    GITHUB_TOKEN: token,
    GITHUB_SERVER_URL: process.env['GITHUB_SERVER_URL'] || 'https://github.com',
    IS_INSTALLATION_TOKEN: isInstallationToken,
    GIT_EMAIL: getInput('GIT_EMAIL') || undefined,
    GIT_USERNAME: getInput('GIT_USERNAME') || undefined,
    CONFIG_PATH: getOptionalInput('CONFIG_PATH', '.github/sync.yml'),
    INLINE_CONFIG: getOptionalInput('INLINE_CONFIG', ''),
    IS_FINE_GRAINED: getBooleanInput('IS_FINE_GRAINED', false),
    COMMIT_BODY: getOptionalInput('COMMIT_BODY', ''),
    COMMIT_PREFIX: getOptionalInput('COMMIT_PREFIX', '🔄'),
    COMMIT_EACH_FILE: getBooleanInput('COMMIT_EACH_FILE', true),
    PR_LABELS: getDisableableArrayInput('PR_LABELS', ['sync']),
    PR_BODY: getOptionalInput('PR_BODY', ''),
    ASSIGNEES: getArrayInput('ASSIGNEES'),
    REVIEWERS: getArrayInput('REVIEWERS'),
    TEAM_REVIEWERS: getArrayInput('TEAM_REVIEWERS'),
    TMP_DIR: getOptionalInput('TMP_DIR', `tmp-${Date.now().toString()}`),
    DRY_RUN: getBooleanInput('DRY_RUN', false),
    SKIP_CLEANUP: getBooleanInput('SKIP_CLEANUP', false),
    OVERWRITE_EXISTING_PR: getBooleanInput('OVERWRITE_EXISTING_PR', true),
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
  let host = new URL(context.GITHUB_SERVER_URL).host;
  let repoPath = fullRepo;

  if (fullRepo.startsWith('http')) {
    const url = new URL(fullRepo);
    host = url.host;
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
 * Raw file configuration from YAML
 */
interface RawFileConfig {
  source?: string;
  dest?: string;
  template?: boolean | Record<string, unknown>;
  replace?: boolean;
  deleteOrphaned?: boolean;
  exclude?: string;
  include?: string;
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
 * Group configuration from YAML
 */
interface GroupConfig {
  repos: string | string[];
  files: (string | RawFileConfig)[];
  branchSuffix?: string;
  reviewers?: string[];
}

/**
 * YAML configuration object type
 */
type YamlConfig = Record<string, (string | RawFileConfig)[] | { group: GroupConfig | GroupConfig[] }>;

/**
 * Parse the sync configuration file and return an array of RepoConfig objects
 */
export async function parseConfig(): Promise<RepoConfig[]> {
  let configObject: YamlConfig;

  if (context.INLINE_CONFIG) {
    configObject = yaml.load(context.INLINE_CONFIG) as YamlConfig;
  } else {
    const fileContent = await fs.promises.readFile(context.CONFIG_PATH);
    configObject = yaml.load(fileContent.toString()) as YamlConfig;
  }

  const result: Record<string, RepoConfig> = {};

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
          const files = parseFiles(group.files);
          const repo = parseRepoName(name);
          const resultKey = `${repo.uniqueName}|${branchSuffix}`;
          const existing = result[resultKey];

          if (existing !== undefined) {
            existing.files.push(...files);
            return;
          }

          const repoConfig: RepoConfig = { repo, files, branchSuffix };
          if (group.reviewers) {
            repoConfig.reviewers = group.reviewers;
          }
          result[resultKey] = repoConfig;
        });
      });
    } else {
      const files = parseFiles(configObject[key] as (string | RawFileConfig)[]);
      const repo = parseRepoName(key);
      const existing = result[repo.uniqueName];

      if (existing !== undefined) {
        existing.files.push(...files);
        return;
      }

      result[repo.uniqueName] = { repo, files, branchSuffix: '' };
    }
  });

  return Object.values(result);
}

export default context;

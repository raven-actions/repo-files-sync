// Repository configuration types
export interface RepoInfo {
  url: string;
  fullName: string;
  uniqueName: string;
  host: string;
  user: string;
  name: string;
  branch: string;
}

export interface FileConfig {
  source: string;
  dest: string;
  template: boolean | Record<string, unknown>;
  replace: boolean;
  deleteOrphaned: boolean;
  exclude: string[] | undefined;
  include?: string[] | undefined;
}

export interface RepoConfig {
  repo: RepoInfo;
  files: FileConfig[];
  branchSuffix: string;
  reviewers?: string[];
}

/**
 * Raw, un-normalized file entry exactly as written in the sync YAML config.
 * These keys are the single source of truth for the file-level options the
 * parser accepts. `FILE_CONFIG_KEYS` is derived from them and asserted against
 * `sync.schema.json` by `tests/schema.test.ts`, so the schema can never silently
 * drift from what the action actually accepts.
 */
export interface RawFileConfig {
  source?: string;
  dest?: string;
  template?: boolean | Record<string, unknown>;
  replace?: boolean;
  deleteOrphaned?: boolean;
  exclude?: string;
  include?: string;
}

/**
 * Group entry exactly as written in the sync YAML config.
 */
export interface GroupConfig {
  repos: string | string[];
  files: (string | RawFileConfig)[];
  branchSuffix?: string;
  reviewers?: string[];
}

// Typing these maps as `Record<keyof X, true>` forces them to enumerate EXACTLY
// the interface keys: adding, renaming, or removing a field on the interface
// above is a TypeScript error here until the map is updated — which in turn
// updates the exported key list and makes the schema conformance test fail until
// `sync.schema.json` is updated too.
const FILE_CONFIG_KEY_MAP: Record<keyof RawFileConfig, true> = {
  source: true,
  dest: true,
  template: true,
  replace: true,
  deleteOrphaned: true,
  exclude: true,
  include: true
};

const GROUP_KEY_MAP: Record<keyof GroupConfig, true> = {
  repos: true,
  files: true,
  branchSuffix: true,
  reviewers: true
};

/** File-level option keys the parser accepts (source of truth for the schema). */
export const FILE_CONFIG_KEYS = Object.keys(FILE_CONFIG_KEY_MAP) as (keyof RawFileConfig)[];

/** Group-level option keys the parser accepts (source of truth for the schema). */
export const GROUP_KEYS = Object.keys(GROUP_KEY_MAP) as (keyof GroupConfig)[];

// Git-related types
export interface TreeDiffEntry {
  newMode: string;
  previousMode: string;
  newBlob: string | null;
  previousBlob: string;
  change: string;
  path: string;
}

export interface GitTreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000' | string;
  type: 'blob' | 'tree' | 'commit';
  sha: string | null;
}

export interface ModifiedFile {
  dest: string;
  source: string | undefined;
  message: string | undefined;
  useOriginalMessage: boolean | undefined;
  commitMessage: string | undefined;
}

// Config context type
export interface ConfigContext {
  GITHUB_TOKEN: string;
  GITHUB_SERVER_URL: string;
  IS_INSTALLATION_TOKEN: boolean;
  GIT_EMAIL: string | undefined;
  GIT_USERNAME: string | undefined;
  CONFIG_PATH: string;
  INLINE_CONFIG: string;
  REPOS: string[] | undefined;
  IS_FINE_GRAINED: boolean;
  COMMIT_BODY: string;
  COMMIT_PREFIX: string;
  COMMIT_EACH_FILE: boolean;
  PR_LABELS: string[] | undefined;
  PR_TITLE: string;
  PR_BODY: string;
  ASSIGNEES: string[] | undefined;
  REVIEWERS: string[] | undefined;
  TEAM_REVIEWERS: string[] | undefined;
  TMP_DIR: string;
  DRY_RUN: boolean;
  SKIP_CLEANUP: boolean;
  OVERWRITE_EXISTING_PR: boolean;
  REBASE: boolean;
  GITHUB_REPOSITORY: string;
  SKIP_PR: boolean;
  ORIGINAL_MESSAGE: boolean;
  COMMIT_AS_PR_TITLE: boolean;
  DELETE_ORPHANED: boolean;
  BRANCH_PREFIX: string;
  FORK: string | false | undefined;
}

// Helper function callback types
export type ForEachCallback<T> = (item: T, index: number, array: T[]) => Promise<void>;

// Git diff output parsed type
export type GitDiffDict = Record<string, string>;

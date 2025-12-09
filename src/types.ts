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
}

export interface RepoConfig {
  repo: RepoInfo;
  files: FileConfig[];
  branchSuffix: string;
  reviewers?: string[];
}

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
  IS_FINE_GRAINED: boolean;
  COMMIT_BODY: string;
  COMMIT_PREFIX: string;
  COMMIT_EACH_FILE: boolean;
  PR_LABELS: string[] | undefined;
  PR_BODY: string;
  ASSIGNEES: string[] | undefined;
  REVIEWERS: string[] | undefined;
  TEAM_REVIEWERS: string[] | undefined;
  TMP_DIR: string;
  DRY_RUN: boolean;
  SKIP_CLEANUP: boolean;
  OVERWRITE_EXISTING_PR: boolean;
  GITHUB_REPOSITORY: string;
  SKIP_PR: boolean;
  ORIGINAL_MESSAGE: boolean;
  COMMIT_AS_PR_TITLE: boolean;
  DELETE_ORPHANED: boolean;
  BRANCH_PREFIX: string;
  FORK: string | false;
}

// Helper function callback types
export type ForEachCallback<T> = (item: T, index: number, array: T[]) => Promise<void>;

// Git diff output parsed type
export type GitDiffDict = Record<string, string>;

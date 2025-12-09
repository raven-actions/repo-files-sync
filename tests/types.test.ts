import { describe, it, expect } from 'vitest';
import type {
  RepoInfo,
  FileConfig,
  RepoConfig,
  ConfigContext,
  TreeDiffEntry,
  GitTreeEntry,
  ModifiedFile,
  ForEachCallback,
  GitDiffDict
} from '../src/types.js';

describe('types.ts - Type Definitions', () => {
  describe('RepoInfo', () => {
    it('should have all required properties', () => {
      const repoInfo: RepoInfo = {
        url: 'https://github.com/user/repo',
        fullName: 'github.com/user/repo',
        uniqueName: 'github.com/user/repo@main',
        host: 'github.com',
        user: 'user',
        name: 'repo',
        branch: 'main'
      };

      expect(repoInfo.url).toBeDefined();
      expect(repoInfo.fullName).toBeDefined();
      expect(repoInfo.uniqueName).toBeDefined();
      expect(repoInfo.host).toBeDefined();
      expect(repoInfo.user).toBeDefined();
      expect(repoInfo.name).toBeDefined();
      expect(repoInfo.branch).toBeDefined();
    });

    it('should correctly format URL', () => {
      const repoInfo: RepoInfo = {
        url: 'https://github.com/owner/repository',
        fullName: 'github.com/owner/repository',
        uniqueName: 'github.com/owner/repository@develop',
        host: 'github.com',
        user: 'owner',
        name: 'repository',
        branch: 'develop'
      };

      expect(repoInfo.url).toMatch(/^https:\/\//);
      expect(repoInfo.url).toContain(repoInfo.user);
      expect(repoInfo.url).toContain(repoInfo.name);
    });
  });

  describe('FileConfig', () => {
    it('should have all required properties', () => {
      const fileConfig: FileConfig = {
        source: 'src/file.txt',
        dest: 'dest/file.txt',
        template: false,
        replace: true,
        deleteOrphaned: false,
        exclude: undefined
      };

      expect(fileConfig.source).toBeDefined();
      expect(fileConfig.dest).toBeDefined();
      expect(typeof fileConfig.template).toBe('boolean');
      expect(typeof fileConfig.replace).toBe('boolean');
      expect(typeof fileConfig.deleteOrphaned).toBe('boolean');
    });

    it('should support template as boolean', () => {
      const fileConfig: FileConfig = {
        source: 'src/file.txt',
        dest: 'dest/file.txt',
        template: true,
        replace: true,
        deleteOrphaned: false,
        exclude: undefined
      };

      expect(fileConfig.template).toBe(true);
    });

    it('should support template as object', () => {
      const fileConfig: FileConfig = {
        source: 'src/file.txt',
        dest: 'dest/file.txt',
        template: { name: 'Test', version: '1.0.0' },
        replace: true,
        deleteOrphaned: false,
        exclude: undefined
      };

      expect(typeof fileConfig.template).toBe('object');
      expect((fileConfig.template as Record<string, unknown>)['name']).toBe('Test');
    });

    it('should support exclude as string array', () => {
      const fileConfig: FileConfig = {
        source: 'src/',
        dest: 'dest/',
        template: false,
        replace: true,
        deleteOrphaned: false,
        exclude: ['node_modules', '.git', '*.log']
      };

      expect(fileConfig.exclude).toHaveLength(3);
      expect(fileConfig.exclude).toContain('node_modules');
    });

    it('should support exclude as undefined', () => {
      const fileConfig: FileConfig = {
        source: 'src/',
        dest: 'dest/',
        template: false,
        replace: true,
        deleteOrphaned: false,
        exclude: undefined
      };

      expect(fileConfig.exclude).toBeUndefined();
    });
  });

  describe('RepoConfig', () => {
    it('should have all required properties', () => {
      const repoConfig: RepoConfig = {
        repo: {
          url: 'https://github.com/user/repo',
          fullName: 'github.com/user/repo',
          uniqueName: 'github.com/user/repo@main',
          host: 'github.com',
          user: 'user',
          name: 'repo',
          branch: 'main'
        },
        files: [],
        branchSuffix: ''
      };

      expect(repoConfig.repo).toBeDefined();
      expect(repoConfig.files).toBeDefined();
      expect(repoConfig.branchSuffix).toBeDefined();
    });

    it('should support optional reviewers', () => {
      const repoConfig: RepoConfig = {
        repo: {
          url: 'https://github.com/user/repo',
          fullName: 'github.com/user/repo',
          uniqueName: 'github.com/user/repo@main',
          host: 'github.com',
          user: 'user',
          name: 'repo',
          branch: 'main'
        },
        files: [],
        branchSuffix: '',
        reviewers: ['reviewer1', 'reviewer2']
      };

      expect(repoConfig.reviewers).toHaveLength(2);
    });

    it('should work without reviewers', () => {
      const repoConfig: RepoConfig = {
        repo: {
          url: 'https://github.com/user/repo',
          fullName: 'github.com/user/repo',
          uniqueName: 'github.com/user/repo@main',
          host: 'github.com',
          user: 'user',
          name: 'repo',
          branch: 'main'
        },
        files: [],
        branchSuffix: ''
      };

      expect(repoConfig.reviewers).toBeUndefined();
    });
  });

  describe('ConfigContext', () => {
    it('should have all required properties', () => {
      const context: ConfigContext = {
        GITHUB_TOKEN: 'token',
        GITHUB_SERVER_URL: 'https://github.com',
        IS_INSTALLATION_TOKEN: false,
        GIT_EMAIL: undefined,
        GIT_USERNAME: undefined,
        CONFIG_PATH: '.github/sync.yml',
        INLINE_CONFIG: '',
        IS_FINE_GRAINED: false,
        COMMIT_BODY: '',
        COMMIT_PREFIX: '🔄',
        COMMIT_EACH_FILE: true,
        PR_LABELS: ['sync'],
        PR_BODY: '',
        ASSIGNEES: undefined,
        REVIEWERS: undefined,
        TEAM_REVIEWERS: undefined,
        TMP_DIR: 'tmp-123',
        DRY_RUN: false,
        SKIP_CLEANUP: false,
        OVERWRITE_EXISTING_PR: true,
        GITHUB_REPOSITORY: 'user/repo',
        SKIP_PR: false,
        ORIGINAL_MESSAGE: false,
        COMMIT_AS_PR_TITLE: false,
        DELETE_ORPHANED: false,
        BRANCH_PREFIX: 'repo-sync/SOURCE_REPO_NAME',
        FORK: false
      };

      expect(context.GITHUB_TOKEN).toBeDefined();
      expect(context.GITHUB_REPOSITORY).toBeDefined();
    });

    it('should support FORK as string (username)', () => {
      const context: ConfigContext = {
        GITHUB_TOKEN: 'token',
        GITHUB_SERVER_URL: 'https://github.com',
        IS_INSTALLATION_TOKEN: false,
        GIT_EMAIL: undefined,
        GIT_USERNAME: undefined,
        CONFIG_PATH: '.github/sync.yml',
        INLINE_CONFIG: '',
        IS_FINE_GRAINED: false,
        COMMIT_BODY: '',
        COMMIT_PREFIX: '🔄',
        COMMIT_EACH_FILE: true,
        PR_LABELS: ['sync'],
        PR_BODY: '',
        ASSIGNEES: undefined,
        REVIEWERS: undefined,
        TEAM_REVIEWERS: undefined,
        TMP_DIR: 'tmp-123',
        DRY_RUN: false,
        SKIP_CLEANUP: false,
        OVERWRITE_EXISTING_PR: true,
        GITHUB_REPOSITORY: 'user/repo',
        SKIP_PR: false,
        ORIGINAL_MESSAGE: false,
        COMMIT_AS_PR_TITLE: false,
        DELETE_ORPHANED: false,
        BRANCH_PREFIX: 'repo-sync/SOURCE_REPO_NAME',
        FORK: 'fork-user'
      };

      expect(context.FORK).toBe('fork-user');
    });
  });

  describe('TreeDiffEntry', () => {
    it('should have all required properties', () => {
      const entry: TreeDiffEntry = {
        newMode: '100644',
        previousMode: '100644',
        newBlob: 'abc123',
        previousBlob: 'def456',
        change: 'M',
        path: 'src/file.txt'
      };

      expect(entry.newMode).toBeDefined();
      expect(entry.previousMode).toBeDefined();
      expect(entry.change).toBeDefined();
      expect(entry.path).toBeDefined();
    });

    it('should support null newBlob for deleted files', () => {
      const entry: TreeDiffEntry = {
        newMode: '000000',
        previousMode: '100644',
        newBlob: null,
        previousBlob: 'abc123',
        change: 'D',
        path: 'deleted-file.txt'
      };

      expect(entry.newBlob).toBeNull();
    });
  });

  describe('GitTreeEntry', () => {
    it('should have all required properties', () => {
      const entry: GitTreeEntry = {
        path: 'src/file.txt',
        mode: '100644',
        type: 'blob',
        sha: 'abc123'
      };

      expect(entry.path).toBeDefined();
      expect(entry.mode).toBeDefined();
      expect(entry.type).toBeDefined();
    });

    it('should support various mode values', () => {
      const modes: GitTreeEntry['mode'][] = ['100644', '100755', '040000', '160000', '120000'];

      modes.forEach((mode) => {
        const entry: GitTreeEntry = {
          path: 'file',
          mode,
          type: 'blob',
          sha: 'abc'
        };
        expect(entry.mode).toBe(mode);
      });
    });

    it('should support null sha for new files', () => {
      const entry: GitTreeEntry = {
        path: 'new-file.txt',
        mode: '100644',
        type: 'blob',
        sha: null
      };

      expect(entry.sha).toBeNull();
    });
  });

  describe('ModifiedFile', () => {
    it('should have required dest property', () => {
      const file: ModifiedFile = {
        dest: 'path/to/file.txt',
        source: undefined,
        message: undefined,
        useOriginalMessage: undefined,
        commitMessage: undefined
      };

      expect(file.dest).toBeDefined();
    });

    it('should support all optional properties', () => {
      const file: ModifiedFile = {
        dest: 'path/to/file.txt',
        source: 'src/file.txt',
        message: 'Synced file',
        useOriginalMessage: true,
        commitMessage: 'Original commit message'
      };

      expect(file.source).toBe('src/file.txt');
      expect(file.message).toBe('Synced file');
      expect(file.useOriginalMessage).toBe(true);
      expect(file.commitMessage).toBe('Original commit message');
    });
  });

  describe('ForEachCallback', () => {
    it('should be a valid async callback type', async () => {
      const callback: ForEachCallback<number> = async (item, index, array) => {
        expect(typeof item).toBe('number');
        expect(typeof index).toBe('number');
        expect(Array.isArray(array)).toBe(true);
      };

      await callback(1, 0, [1, 2, 3]);
    });
  });

  describe('GitDiffDict', () => {
    it('should be a string-to-string record', () => {
      const dict: GitDiffDict = {
        'file1.txt': 'added',
        'file2.txt': 'modified',
        'file3.txt': 'deleted'
      };

      expect(Object.keys(dict)).toHaveLength(3);
      expect(dict['file1.txt']).toBe('added');
    });
  });
});

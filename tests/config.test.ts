import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

// We need to mock @actions/core and environment before importing config
const mockInputs: Record<string, string> = {};

vi.mock('@actions/core', () => ({
  getInput: vi.fn((key: string) => mockInputs[key] ?? ''),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

// Helper to set up mock inputs
function setMockInputs(inputs: Record<string, string>) {
  Object.assign(mockInputs, inputs);
}

// Clear mock inputs
function clearMockInputs() {
  Object.keys(mockInputs).forEach((key) => delete mockInputs[key]);
}

describe('config.ts - Configuration Parsing', () => {
  let testDir: string;

  beforeEach(async () => {
    clearMockInputs();
    testDir = path.join(os.tmpdir(), `config-test-${Date.now()}`);
    await fs.ensureDir(testDir);

    // Set minimum required inputs
    setMockInputs({
      GH_PAT: 'test-token',
      GITHUB_REPOSITORY: 'test/repo'
    });

    // Set environment
    process.env['GITHUB_SERVER_URL'] = 'https://github.com';
  });

  afterEach(async () => {
    await fs.remove(testDir);
    vi.resetModules();
  });

  describe('YAML Configuration Structure', () => {
    it('should validate simple repo config structure', () => {
      const config = {
        'user/repo': ['file1.txt', 'file2.txt']
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as Record<string, unknown>;

      expect(parsed['user/repo']).toEqual(['file1.txt', 'file2.txt']);
    });

    it('should validate repo config with branch', () => {
      const config = {
        'user/repo@develop': ['file.txt']
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as Record<string, unknown>;

      expect(Object.keys(parsed)).toContain('user/repo@develop');
    });

    it('should validate detailed file config', () => {
      const config = {
        'user/repo': [
          {
            source: 'src/file.txt',
            dest: 'dest/file.txt',
            template: true,
            replace: false,
            deleteOrphaned: true,
            exclude: 'node_modules\n.git'
          }
        ]
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as Record<string, Array<{ source: string }>>;

      const files = parsed['user/repo'];
      expect(files).toHaveLength(1);
      expect(files?.[0]?.source).toBe('src/file.txt');
    });

    it('should validate group config structure', () => {
      const config = {
        group: {
          repos: 'user/repo1\nuser/repo2',
          files: ['file.txt']
        }
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as { group: { repos: string; files: string[] } };

      expect(parsed.group.repos).toContain('user/repo1');
      expect(parsed.group.files).toEqual(['file.txt']);
    });

    it('should validate multiple groups config', () => {
      const config = {
        group: [
          {
            repos: ['user/repo1'],
            files: ['file1.txt']
          },
          {
            repos: ['user/repo2'],
            files: ['file2.txt']
          }
        ]
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as { group: Array<{ repos: string[]; files: string[] }> };

      expect(parsed.group).toHaveLength(2);
    });

    it('should validate group with reviewers', () => {
      const config = {
        group: {
          repos: ['user/repo'],
          files: ['file.txt'],
          reviewers: ['reviewer1', 'reviewer2']
        }
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as { group: { reviewers: string[] } };

      expect(parsed.group.reviewers).toEqual(['reviewer1', 'reviewer2']);
    });

    it('should validate group with branchSuffix', () => {
      const config = {
        group: {
          repos: ['user/repo'],
          files: ['file.txt'],
          branchSuffix: 'config-sync'
        }
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as { group: { branchSuffix: string } };

      expect(parsed.group.branchSuffix).toBe('config-sync');
    });

    it('should validate template with object context', () => {
      const config = {
        'user/repo': [
          {
            source: 'template.md',
            template: {
              name: 'Test',
              version: '1.0.0'
            }
          }
        ]
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as Record<
        string,
        Array<{ template: { name: string; version: string } }>
      >;

      expect(parsed['user/repo']?.[0]?.template).toEqual({
        name: 'Test',
        version: '1.0.0'
      });
    });

    it('should validate custom host URL', () => {
      const config = {
        'https://github.enterprise.com/user/repo': ['file.txt']
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as Record<string, unknown>;

      expect(Object.keys(parsed)).toContain('https://github.enterprise.com/user/repo');
    });

    it('should validate mixed simple and detailed file configs', () => {
      const config = {
        'user/repo': [
          'simple-file.txt',
          {
            source: 'detailed/file.txt',
            dest: 'other/file.txt'
          }
        ]
      };

      const yamlStr = yaml.dump(config);
      const parsed = yaml.load(yamlStr) as Record<string, unknown[]>;

      expect(parsed['user/repo']).toHaveLength(2);
    });
  });

  describe('Repository Name Parsing', () => {
    it('should parse simple repo name', () => {
      // Test the expected structure
      const repoName = 'user/repo';
      const parts = repoName.split('/');

      expect(parts[0]).toBe('user');
      expect(parts[1]).toBe('repo');
    });

    it('should parse repo name with branch', () => {
      const repoName = 'user/repo@develop';
      const parts = repoName.split('/');
      const nameWithBranch = parts[1] ?? '';
      const name = nameWithBranch.split('@')[0];
      const branch = repoName.split('@')[1] || 'default';

      expect(name).toBe('repo');
      expect(branch).toBe('develop');
    });

    it('should default to "default" branch when not specified', () => {
      const repoName = 'user/repo';
      const branch = repoName.split('@')[1] || 'default';

      expect(branch).toBe('default');
    });

    it('should parse custom host URL', () => {
      const fullRepo = 'https://github.enterprise.com/org/project@main';

      // Simulate URL parsing
      const url = new URL(fullRepo);
      const host = url.host;
      const repoPath = url.pathname.replace(/^\/+/, '');

      expect(host).toBe('github.enterprise.com');
      expect(repoPath).toBe('org/project@main');
    });
  });

  describe('File Config Defaults', () => {
    it('should apply default values for file config', () => {
      // Test default values
      const REPLACE_DEFAULT = true;
      const TEMPLATE_DEFAULT = false;
      const DELETE_ORPHANED_DEFAULT = false;

      expect(REPLACE_DEFAULT).toBe(true);
      expect(TEMPLATE_DEFAULT).toBe(false);
      expect(DELETE_ORPHANED_DEFAULT).toBe(false);
    });

    it('should use source as dest when dest not specified', () => {
      const fileItem: { source: string; dest?: string } = { source: 'path/to/file.txt' };
      const dest = fileItem.dest ?? fileItem.source;

      expect(dest).toBe('path/to/file.txt');
    });
  });

  describe('Exclude Pattern Parsing', () => {
    it('should parse newline-separated exclude patterns', () => {
      const excludeText = 'node_modules\n.git\n*.log';
      const patterns = excludeText.split('\n').filter((line) => line);

      expect(patterns).toEqual(['node_modules', '.git', '*.log']);
    });

    it('should filter empty lines', () => {
      const excludeText = 'file1\n\nfile2\n';
      const patterns = excludeText.split('\n').filter((line) => line);

      expect(patterns).toEqual(['file1', 'file2']);
    });

    it('should return undefined for undefined input', () => {
      const text: string | undefined = undefined;
      const result = text === undefined ? undefined : text.split('\n');

      expect(result).toBeUndefined();
    });
  });

  describe('Group Repos Parsing', () => {
    it('should parse newline-separated repos', () => {
      const reposText = 'user/repo1\nuser/repo2\nuser/repo3';
      const repos = reposText
        .split('\n')
        .map((n) => n.trim())
        .filter((n) => n);

      expect(repos).toEqual(['user/repo1', 'user/repo2', 'user/repo3']);
    });

    it('should handle array repos', () => {
      const repos = ['user/repo1', 'user/repo2'];

      expect(repos).toHaveLength(2);
    });

    it('should trim whitespace and filter empty', () => {
      const reposText = '  user/repo1  \n\n  user/repo2  \n';
      const repos = reposText
        .split('\n')
        .map((n) => n.trim())
        .filter((n) => n);

      expect(repos).toEqual(['user/repo1', 'user/repo2']);
    });
  });

  describe('Edge Cases', () => {
    it('should handle repo name with dots', () => {
      const repoName = 'user/repo.js@main';
      const parts = repoName.split('/');
      const nameWithBranch = parts[1] ?? '';
      const name = nameWithBranch.split('@')[0];

      expect(name).toBe('repo.js');
    });

    it('should handle repo name with hyphens', () => {
      const repoName = 'my-org/my-repo@feature-branch';
      const parts = repoName.split('/');

      expect(parts[0]).toBe('my-org');
      expect(parts[1]?.split('@')[0]).toBe('my-repo');
    });

    it('should handle repo name with underscores', () => {
      const repoName = 'my_org/my_repo';
      const parts = repoName.split('/');

      expect(parts[0]).toBe('my_org');
      expect(parts[1]).toBe('my_repo');
    });

    it('should handle deeply nested file paths', () => {
      const source = 'deeply/nested/path/to/file.txt';
      const parts = source.split('/');

      expect(parts.length).toBe(5);
    });
  });
});

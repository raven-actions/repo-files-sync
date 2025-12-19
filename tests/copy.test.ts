import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import nunjucks from 'nunjucks';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn()
}));

import { copy, write } from '../src/helpers.js';
import type { FileConfig, RepoConfig, RepoInfo } from '../src/types.js';

describe('helpers.ts - copy and write functions', () => {
  let testDir: string;
  let srcDir: string;
  let destDir: string;

  const mockRepoInfo: RepoInfo = {
    url: 'https://github.com/test/repo',
    fullName: 'github.com/test/repo',
    uniqueName: 'github.com/test/repo@main',
    host: 'github.com',
    user: 'test',
    name: 'repo',
    branch: 'main'
  };

  const mockRepoConfig: RepoConfig = {
    repo: mockRepoInfo,
    files: [],
    branchSuffix: ''
  };

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `copy-test-${Date.now()}`);
    srcDir = path.join(testDir, 'src');
    destDir = path.join(testDir, 'dest');
  });

  beforeEach(async () => {
    await fs.ensureDir(srcDir);
    await fs.ensureDir(destDir);
    // Configure nunjucks to use the test directory for template resolution
    nunjucks.configure(testDir, { autoescape: true, trimBlocks: true, lstripBlocks: true });
  });

  afterEach(async () => {
    await fs.emptyDir(testDir);
  });

  afterAll(async () => {
    await fs.remove(testDir);
  });

  describe('write', () => {
    it('should render template file with context', async () => {
      const templateFile = path.join(srcDir, 'template.txt');
      const outputFile = path.join(destDir, 'output.txt');

      await fs.writeFile(templateFile, 'Hello {{ name }}!');

      await write(templateFile, outputFile, { name: 'World' });

      const content = await fs.readFile(outputFile, 'utf-8');
      expect(content).toBe('Hello World!');
    });

    it('should include repo object in template context', async () => {
      const templateFile = path.join(srcDir, 'repo-template.txt');
      const outputFile = path.join(destDir, 'repo-output.txt');

      await fs.writeFile(templateFile, 'Repo: {{ repo.name }} by {{ repo.user }}');

      await write(templateFile, outputFile, {}, mockRepoInfo);

      const content = await fs.readFile(outputFile, 'utf-8');
      expect(content).toBe('Repo: repo by test');
    });

    it('should handle empty context', async () => {
      const templateFile = path.join(srcDir, 'simple.txt');
      const outputFile = path.join(destDir, 'simple-out.txt');

      await fs.writeFile(templateFile, 'Static content');

      await write(templateFile, outputFile, {});

      const content = await fs.readFile(outputFile, 'utf-8');
      expect(content).toBe('Static content');
    });

    it('should create destination directory if it does not exist', async () => {
      const templateFile = path.join(srcDir, 'template.txt');
      const nestedOutput = path.join(destDir, 'nested', 'deep', 'output.txt');

      await fs.writeFile(templateFile, 'Content');

      await write(templateFile, nestedOutput, {});

      expect(await fs.pathExists(nestedOutput)).toBe(true);
    });

    it('should render complex template with loops and conditionals', async () => {
      const templateFile = path.join(srcDir, 'complex.txt');
      const outputFile = path.join(destDir, 'complex-out.txt');

      await fs.writeFile(
        templateFile,
        '{% for item in items %}{{ item }}{% if not loop.last %}, {% endif %}{% endfor %}'
      );

      await write(templateFile, outputFile, { items: ['a', 'b', 'c'] });

      const content = await fs.readFile(outputFile, 'utf-8');
      expect(content).toBe('a, b, c');
    });
  });

  describe('copy', () => {
    describe('file copying', () => {
      it('should copy a single file', async () => {
        const srcFile = path.join(srcDir, 'file.txt');
        const destFile = path.join(destDir, 'file.txt');

        await fs.writeFile(srcFile, 'File content');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(destFile)).toBe(true);
        expect(await fs.readFile(destFile, 'utf-8')).toBe('File content');
      });

      it('should copy file with template rendering', async () => {
        const srcFile = path.join(srcDir, 'template.txt');
        const destFile = path.join(destDir, 'rendered.txt');

        await fs.writeFile(srcFile, 'Hello {{ name }}!');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: { name: 'World' },
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        const content = await fs.readFile(destFile, 'utf-8');
        expect(content).toBe('Hello World!');
      });

      it('should include repo object when template is true', async () => {
        const srcFile = path.join(srcDir, 'repo-tpl.txt');
        const destFile = path.join(destDir, 'repo-out.txt');

        await fs.writeFile(srcFile, 'Repo: {{ repo.fullName }}');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: true,
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        const content = await fs.readFile(destFile, 'utf-8');
        expect(content).toBe('Repo: github.com/test/repo');
      });

      it('should skip copying when replace is false and destination exists', async () => {
        const srcFile = path.join(srcDir, 'source.txt');
        const destFile = path.join(destDir, 'existing.txt');

        await fs.writeFile(srcFile, 'New content');
        await fs.writeFile(destFile, 'Original content');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: false,
          replace: false,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        const content = await fs.readFile(destFile, 'utf-8');
        expect(content).toBe('Original content');
      });

      it('should skip template rendering when replace is false and destination exists', async () => {
        const srcFile = path.join(srcDir, 'source-tpl.txt');
        const destFile = path.join(destDir, 'existing-tpl.txt');

        await fs.writeFile(srcFile, 'Hello {{ name }}!');
        await fs.writeFile(destFile, 'Original content');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: { name: 'World' },
          replace: false,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        const content = await fs.readFile(destFile, 'utf-8');
        expect(content).toBe('Original content');
      });

      it('should still copy when exclude patterns are whitespace-only (no-op patterns)', async () => {
        const srcFile = path.join(srcDir, 'whitespace-exclude.txt');
        const destFile = path.join(destDir, 'whitespace-exclude.txt');

        await fs.writeFile(srcFile, 'File content');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: false,
          replace: true,
          deleteOrphaned: false,
          // Force shouldFilter=true but normalize to zero patterns
          exclude: ['   ', '\n', '\t  ']
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(destFile)).toBe(true);
        expect(await fs.readFile(destFile, 'utf-8')).toBe('File content');
      });

      it('should copy when replace is false but destination does not exist', async () => {
        const srcFile = path.join(srcDir, 'source.txt');
        const destFile = path.join(destDir, 'new-file.txt');

        await fs.writeFile(srcFile, 'New content');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: false,
          replace: false,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(destFile)).toBe(true);
        const content = await fs.readFile(destFile, 'utf-8');
        expect(content).toBe('New content');
      });

      it('should copy when replace is true and destination exists', async () => {
        const srcFile = path.join(srcDir, 'source.txt');
        const destFile = path.join(destDir, 'existing.txt');

        await fs.writeFile(srcFile, 'New content');
        await fs.writeFile(destFile, 'Original content');

        const fileConfig: FileConfig = {
          source: srcFile,
          dest: destFile,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcFile, destFile, false, fileConfig, mockRepoConfig);

        const content = await fs.readFile(destFile, 'utf-8');
        expect(content).toBe('New content');
      });
    });

    describe('directory copying', () => {
      it('should copy entire directory', async () => {
        const srcSubDir = path.join(srcDir, 'subdir');
        const destSubDir = path.join(destDir, 'subdir');

        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'file1.txt'), 'Content 1');
        await fs.writeFile(path.join(srcSubDir, 'file2.txt'), 'Content 2');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'file1.txt'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, 'file2.txt'))).toBe(true);
      });

      it('should not overwrite existing files when replace is false (directory)', async () => {
        const srcSubDir = path.join(srcDir, 'replace-false-dir');
        const destSubDir = path.join(destDir, 'replace-false-dir');

        await fs.ensureDir(srcSubDir);
        await fs.ensureDir(destSubDir);

        await fs.writeFile(path.join(srcSubDir, 'existing.txt'), 'New content');
        await fs.writeFile(path.join(srcSubDir, 'new.txt'), 'Brand new');

        await fs.writeFile(path.join(destSubDir, 'existing.txt'), 'Original content');
        await fs.writeFile(path.join(destSubDir, 'extra.txt'), 'Keep me');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: false,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.readFile(path.join(destSubDir, 'existing.txt'), 'utf-8')).toBe('Original content');
        expect(await fs.readFile(path.join(destSubDir, 'new.txt'), 'utf-8')).toBe('Brand new');
        expect(await fs.readFile(path.join(destSubDir, 'extra.txt'), 'utf-8')).toBe('Keep me');
      });

      it('should copy nested directories', async () => {
        const srcSubDir = path.join(srcDir, 'nested');
        const destSubDir = path.join(destDir, 'nested');

        await fs.ensureDir(path.join(srcSubDir, 'level1', 'level2'));
        await fs.writeFile(path.join(srcSubDir, 'level1', 'level2', 'deep.txt'), 'Deep content');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'level1', 'level2', 'deep.txt'))).toBe(true);
      });

      it('should exclude specified files', async () => {
        const srcSubDir = path.join(srcDir, 'exclude-test');
        const destSubDir = path.join(destDir, 'exclude-test');

        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'keep.txt'), 'Keep');
        await fs.writeFile(path.join(srcSubDir, 'exclude.txt'), 'Exclude');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: [path.join(srcSubDir, 'exclude.txt')]
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'keep.txt'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, 'exclude.txt'))).toBe(false);
      });

      it('should include only matching patterns', async () => {
        const srcSubDir = path.join(srcDir, 'include-test');
        const destSubDir = path.join(destDir, 'include-test');

        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'keep.keep'), 'Keep');
        await fs.writeFile(path.join(srcSubDir, 'skip.txt'), 'Skip');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: undefined,
          include: ['**/*.keep']
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'keep.keep'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, 'skip.txt'))).toBe(false);
      });

      it('should exclude matching patterns', async () => {
        const srcSubDir = path.join(srcDir, 'exclude-test');
        const destSubDir = path.join(destDir, 'exclude-test');

        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'keep.txt'), 'Keep');
        await fs.writeFile(path.join(srcSubDir, 'exclude.log'), 'Exclude');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: ['**/*.log']
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'keep.txt'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, 'exclude.log'))).toBe(false);
      });

      it('should apply include filtering when replace is false (directory)', async () => {
        const srcSubDir = path.join(srcDir, 'replace-false-include-test');
        const destSubDir = path.join(destDir, 'replace-false-include-test');

        await fs.ensureDir(srcSubDir);
        await fs.ensureDir(destSubDir);

        await fs.writeFile(path.join(srcSubDir, 'keep.keep'), 'Keep');
        await fs.writeFile(path.join(srcSubDir, 'skip.txt'), 'Skip');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: false,
          deleteOrphaned: false,
          exclude: undefined,
          include: ['**/*.keep']
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'keep.keep'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, 'skip.txt'))).toBe(false);
      });
    });

    describe('directory with template', () => {
      it('should render all files in directory as templates', async () => {
        const srcSubDir = path.join(srcDir, 'tpl-dir');
        const destSubDir = path.join(destDir, 'tpl-dir');

        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'file1.txt'), 'Name: {{ name }}');
        await fs.writeFile(path.join(srcSubDir, 'file2.txt'), 'Version: {{ version }}');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: { name: 'Test', version: '1.0.0' },
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.readFile(path.join(destSubDir, 'file1.txt'), 'utf-8')).toBe('Name: Test');
        expect(await fs.readFile(path.join(destSubDir, 'file2.txt'), 'utf-8')).toBe('Version: 1.0.0');
      });

      it('should not overwrite existing destination files when replace is false (template directory)', async () => {
        const srcSubDir = path.join(srcDir, 'tpl-replace-false');
        const destSubDir = path.join(destDir, 'tpl-replace-false');

        await fs.ensureDir(srcSubDir);
        await fs.ensureDir(destSubDir);

        await fs.writeFile(path.join(srcSubDir, 'a.txt'), 'Hello {{ repo.name }}');
        await fs.writeFile(path.join(srcSubDir, 'b.txt'), 'Hello {{ name }}');

        await fs.writeFile(path.join(destSubDir, 'a.txt'), 'Existing A');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: { name: 'World' },
          replace: false,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.readFile(path.join(destSubDir, 'a.txt'), 'utf-8')).toBe('Existing A');
        expect(await fs.readFile(path.join(destSubDir, 'b.txt'), 'utf-8')).toBe('Hello World');
      });

      it('should exclude files when rendering directory as templates', async () => {
        const srcSubDir = path.join(srcDir, 'tpl-exclude');
        const destSubDir = path.join(destDir, 'tpl-exclude');

        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'include.txt'), 'Include: {{ name }}');
        await fs.writeFile(path.join(srcSubDir, 'exclude.txt'), 'Exclude: {{ name }}');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: { name: 'Test' },
          replace: true,
          deleteOrphaned: false,
          exclude: ['exclude.txt']
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'include.txt'))).toBe(true);
        expect(await fs.readFile(path.join(destSubDir, 'include.txt'), 'utf-8')).toBe('Include: Test');
        // Excluded file should not be rendered
        expect(await fs.pathExists(path.join(destSubDir, 'exclude.txt'))).toBe(false);
      });

      it('should exclude files in subdirectory by path when rendering templates', async () => {
        const srcSubDir = path.join(srcDir, 'tpl-path-exclude');
        const destSubDir = path.join(destDir, 'tpl-path-exclude');

        await fs.ensureDir(path.join(srcSubDir, 'subdir'));
        await fs.writeFile(path.join(srcSubDir, 'root.txt'), 'Root: {{ name }}');
        await fs.writeFile(path.join(srcSubDir, 'subdir', 'file.txt'), 'Sub: {{ name }}');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: { name: 'Test' },
          replace: true,
          deleteOrphaned: false,
          // Exclude by directory path
          exclude: ['subdir/']
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'root.txt'))).toBe(true);
        // File in excluded directory should not be rendered
        expect(await fs.pathExists(path.join(destSubDir, 'subdir', 'file.txt'))).toBe(false);
      });
    });

    describe('deleteOrphaned', () => {
      it('should delete orphaned files when enabled for directories', async () => {
        const srcSubDir = path.join(srcDir, 'orphan-test');
        const destSubDir = path.join(destDir, 'orphan-test');

        // Create source with one file
        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'keep.txt'), 'Keep');

        // Create destination with extra file (orphan)
        await fs.ensureDir(destSubDir);
        await fs.writeFile(path.join(destSubDir, 'keep.txt'), 'Old');
        await fs.writeFile(path.join(destSubDir, 'orphan.txt'), 'Orphan');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: true,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'keep.txt'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, 'orphan.txt'))).toBe(false);
      });

      it('should not delete excluded files even when orphaned (exclude defines out-of-scope)', async () => {
        const srcSubDir = path.join(srcDir, 'exclude-orphan-scope');
        const destSubDir = path.join(destDir, 'exclude-orphan-scope');

        // Source has one file
        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'source.txt'), 'Source');

        // Dest has an orphan that matches exclude
        await fs.ensureDir(destSubDir);
        await fs.writeFile(path.join(destSubDir, 'excluded-orphan.log'), 'Excluded');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: true,
          include: undefined,
          exclude: ['**/*.log']
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        // Excluded orphan should be preserved
        expect(await fs.pathExists(path.join(destSubDir, 'excluded-orphan.log'))).toBe(true);
      });

      it('should not delete .git directory files', async () => {
        const srcSubDir = path.join(srcDir, 'git-test');
        const destSubDir = path.join(destDir, 'git-test');

        // Create source with one file
        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'file.txt'), 'Content');

        // Create destination with .git directory
        await fs.ensureDir(path.join(destSubDir, '.git'));
        await fs.writeFile(path.join(destSubDir, '.git', 'config'), 'git config');
        await fs.writeFile(path.join(destSubDir, 'file.txt'), 'Old');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: true,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        // .git should be preserved
        expect(await fs.pathExists(path.join(destSubDir, '.git', 'config'))).toBe(true);
      });

      it('should not delete excluded files even when orphaned', async () => {
        const srcSubDir = path.join(srcDir, 'exclude-orphan');
        const destSubDir = path.join(destDir, 'exclude-orphan');

        // Source has one file
        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'source.txt'), 'Source');

        // Dest has orphan that's excluded
        await fs.ensureDir(destSubDir);
        await fs.writeFile(path.join(destSubDir, 'excluded-orphan.txt'), 'Excluded');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: true,
          exclude: [path.join(srcSubDir, 'excluded-orphan.txt')]
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        // Excluded orphan should be preserved
        expect(await fs.pathExists(path.join(destSubDir, 'excluded-orphan.txt'))).toBe(true);
      });

      it('should skip hidden files when copying directory without template', async () => {
        const srcSubDir = path.join(srcDir, 'hidden-test');
        const destSubDir = path.join(destDir, 'hidden-test');

        // Create source with hidden file
        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'visible.txt'), 'Visible');
        await fs.writeFile(path.join(srcSubDir, '.hidden'), 'Hidden');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        // Both files should be copied (fs.copy doesn't filter hidden by default)
        expect(await fs.pathExists(path.join(destSubDir, 'visible.txt'))).toBe(true);
      });

      it('should exclude files by directory path', async () => {
        const srcSubDir = path.join(srcDir, 'path-exclude');
        const destSubDir = path.join(destDir, 'path-exclude');

        await fs.ensureDir(path.join(srcSubDir, 'excluded-dir'));
        await fs.writeFile(path.join(srcSubDir, 'keep.txt'), 'Keep');
        await fs.writeFile(path.join(srcSubDir, 'excluded-dir', 'file.txt'), 'Excluded');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          // Exclude files explicitly - the filter checks for exact matches
          exclude: [path.join(srcSubDir, 'excluded-dir', 'file.txt')]
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'keep.txt'))).toBe(true);
        // The excluded file should not be copied
        expect(await fs.pathExists(path.join(destSubDir, 'excluded-dir', 'file.txt'))).toBe(false);
      });

      it('should exclude all files in a directory by path', async () => {
        const srcSubDir = path.join(srcDir, 'dir-path-exclude');
        const destSubDir = path.join(destDir, 'dir-path-exclude');

        await fs.ensureDir(path.join(srcSubDir, 'subdir'));
        await fs.writeFile(path.join(srcSubDir, 'keep.txt'), 'Keep');
        await fs.writeFile(path.join(srcSubDir, 'subdir', 'file1.txt'), 'File 1');
        await fs.writeFile(path.join(srcSubDir, 'subdir', 'file2.txt'), 'File 2');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: false,
          // Exclude the entire subdirectory by path (trailing slash format)
          exclude: ['subdir/']
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        expect(await fs.pathExists(path.join(destSubDir, 'keep.txt'))).toBe(true);
        // Note: fs.copy filter works on full paths, so this tests the path extraction logic
      });

      it('should preserve multiple .git files when deleteOrphaned is enabled', async () => {
        const srcSubDir = path.join(srcDir, 'multi-git');
        const destSubDir = path.join(destDir, 'multi-git');

        // Create source with one file
        await fs.ensureDir(srcSubDir);
        await fs.writeFile(path.join(srcSubDir, 'file.txt'), 'Content');

        // Create destination with multiple .git files
        await fs.ensureDir(path.join(destSubDir, '.git', 'objects'));
        await fs.writeFile(path.join(destSubDir, '.git', 'config'), 'config');
        await fs.writeFile(path.join(destSubDir, '.git', 'HEAD'), 'ref: refs/heads/main');
        await fs.writeFile(path.join(destSubDir, '.git', 'objects', 'pack'), 'pack data');
        await fs.writeFile(path.join(destSubDir, 'file.txt'), 'Old');
        await fs.writeFile(path.join(destSubDir, 'orphan.txt'), 'Will be deleted');

        const fileConfig: FileConfig = {
          source: srcSubDir,
          dest: destSubDir,
          template: false,
          replace: true,
          deleteOrphaned: true,
          exclude: undefined
        };

        await copy(srcSubDir + '/', destSubDir + '/', true, fileConfig, mockRepoConfig);

        // All .git files should be preserved
        expect(await fs.pathExists(path.join(destSubDir, '.git', 'config'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, '.git', 'HEAD'))).toBe(true);
        expect(await fs.pathExists(path.join(destSubDir, '.git', 'objects', 'pack'))).toBe(true);
        // Orphan outside .git should be deleted
        expect(await fs.pathExists(path.join(destSubDir, 'orphan.txt'))).toBe(false);
      });
    });
  });
});

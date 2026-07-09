import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

// Mock @actions/core before importing helpers
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

import {
  forEach,
  dedent,
  execGit,
  execGitBuffer,
  addTrailingSlash,
  pathIsDirectory,
  resolvePathWithinRoot,
  createFilterFunc,
  arrayEquals,
  remove
} from '../src/helpers.js';

describe('helpers.ts', () => {
  describe('createFilterFunc', () => {
    let testDir: string;

    beforeAll(async () => {
      testDir = path.join(os.tmpdir(), `create-filter-func-test-${Date.now()}`);
      await fs.ensureDir(testDir);
    });

    afterAll(async () => {
      await fs.remove(testDir);
    });

    it('should not filter paths outside source root (returns true)', async () => {
      const root = path.join(testDir, 'root');
      const outside = path.join(testDir, 'outside.txt');
      await fs.ensureDir(root);
      await fs.writeFile(outside, 'outside');

      const filter = createFilterFunc(root, undefined, ['**/*.nope']);
      expect(filter(outside)).toBe(true);
    });

    it('should always allow directories so traversal can continue', async () => {
      const root = path.join(testDir, 'root2');
      const subDir = path.join(root, 'subdir');
      await fs.ensureDir(subDir);

      const filter = createFilterFunc(root, undefined, ['**/*.nope']);
      expect(filter(subDir)).toBe(true);
    });

    it('should apply negated include patterns to the full pattern set', () => {
      const root = path.join(testDir, 'negated-include');
      const filter = createFilterFunc(root, undefined, ['src/**', '!./src/generated/**']);

      expect(filter(path.join(root, 'src', 'index.ts'))).toBe(true);
      expect(filter(path.join(root, 'src', 'generated', 'client.ts'))).toBe(false);
      expect(filter(path.join(root, 'docs', 'guide.ts'))).toBe(false);
    });

    it('should exclude descendants of a bare directory pattern', () => {
      const root = path.join(testDir, 'directory-exclude');
      const filter = createFilterFunc(root, ['node_modules'], undefined);

      expect(filter(path.join(root, 'node_modules', 'package', 'index.js'))).toBe(false);
      expect(filter(path.join(root, 'src', 'index.js'))).toBe(true);
    });

    it('should filter an in-root filename that begins with two dots', () => {
      const root = path.join(testDir, 'dot-prefix');
      const filter = createFilterFunc(root, ['..debug.log'], undefined);

      expect(filter(path.join(root, '..debug.log'))).toBe(false);
    });

    it('should always exclude Git metadata', () => {
      const root = path.join(testDir, 'git-metadata');
      const filter = createFilterFunc(root, undefined, undefined);

      expect(filter(path.join(root, '.git', 'config'))).toBe(false);
      expect(filter(path.join(root, '.gitignore'))).toBe(true);
    });
  });

  describe('forEach', () => {
    it('should process array items sequentially', async () => {
      const items = [1, 2, 3];
      const results: number[] = [];

      await forEach(items, async (item) => {
        results.push(item);
      });

      expect(results).toEqual([1, 2, 3]);
    });

    it('should pass correct index and array to callback', async () => {
      const items = ['a', 'b', 'c'];
      const indices: number[] = [];
      const arrays: string[][] = [];

      await forEach(items, async (_item, index, array) => {
        indices.push(index);
        arrays.push([...array]);
      });

      expect(indices).toEqual([0, 1, 2]);
      expect(arrays[0]).toEqual(['a', 'b', 'c']);
    });

    it('should handle empty array', async () => {
      const results: unknown[] = [];

      await forEach([], async (item) => {
        results.push(item);
      });

      expect(results).toEqual([]);
    });

    it('should handle async callbacks', async () => {
      const items = [1, 2, 3];
      const results: number[] = [];

      await forEach(items, async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(item * 2);
      });

      expect(results).toEqual([2, 4, 6]);
    });

    it('should skip undefined items', async () => {
      const items = [1, undefined, 3] as (number | undefined)[];
      const results: number[] = [];

      await forEach(items, async (item) => {
        results.push(item as number);
      });

      // undefined items are skipped
      expect(results).toEqual([1, 3]);
    });
  });

  describe('dedent', () => {
    it('should remove leading indentation from multiline strings', () => {
      const result = dedent`
        Hello
        World
      `;

      expect(result).toBe('Hello\nWorld');
    });

    it('should handle mixed indentation', () => {
      const result = dedent`
        Line 1
          Indented Line 2
        Line 3
      `;

      expect(result).toBe('Line 1\n  Indented Line 2\nLine 3');
    });

    it('should handle template literals with values', () => {
      const name = 'World';
      const result = dedent`
        Hello
        ${name}
      `;

      expect(result).toBe('Hello\nWorld');
    });

    it('should handle single line strings', () => {
      const result = dedent`Hello World`;

      expect(result).toBe('Hello World');
    });

    it('should handle empty strings', () => {
      const result = dedent``;

      expect(result).toBe('');
    });

    it('should handle strings with tabs', () => {
      const result = dedent`
				Tab indented
				Line 2
			`;

      expect(result).toBe('Tab indented\nLine 2');
    });

    it('should work with plain string input (no dedent)', () => {
      // When called as a function with a plain string, dedent treats it differently
      // The string is put in an array and processed, but without template literal
      // interpolation behavior, so it doesn't dedent like a tagged template
      const result = dedent('  Hello\n  World');

      // Plain string call - first line has no newline prefix so no match for indentation removal
      expect(result).toBe('  Hello\nWorld');
    });

    it('should handle multiple values', () => {
      const a = 'A';
      const b = 'B';
      const result = dedent`
        ${a} and ${b}
        Together
      `;

      expect(result).toBe('A and B\nTogether');
    });
  });

  describe('execGit', () => {
    it('should execute git command and return trimmed output', async () => {
      const result = await execGit(['--version']);

      expect(result).toMatch(/^git version/);
      expect(result).not.toMatch(/\s$/);
    });

    it('should not trim when trimResult is false', async () => {
      const result = await execGit(['--version'], undefined, false);

      expect(result).toMatch(/[\r\n]$/);
    });

    it('should execute in specified working directory', async () => {
      const repoDir = path.join(os.tmpdir(), `exec-git-test-${Date.now()}`);
      await fs.ensureDir(repoDir);

      try {
        await execGit(['init'], repoDir);
        const result = await execGit(['rev-parse', '--is-inside-work-tree'], repoDir);

        expect(result).toBe('true');
      } finally {
        await fs.remove(repoDir);
      }
    });

    it('should reject on git error', async () => {
      await expect(execGit(['not-a-real-git-subcommand-xyz'])).rejects.toThrow();
    });

    it('should pass arguments literally without shell interpolation', async () => {
      // `git rev-parse --sq-quote` echoes its argument back, shell-quoted.
      // Because execGit uses execFile (no shell), metacharacters survive verbatim
      // instead of being expanded/executed.
      const payload = 'a; rm -rf / && echo $(whoami)';
      const result = await execGit(['rev-parse', '--sq-quote', payload]);

      expect(result).toContain('rm -rf');
      expect(result).toContain('$(whoami)');
    });

    it('should return binary output without UTF-8 decoding', async () => {
      const repoDir = path.join(os.tmpdir(), `exec-git-buffer-test-${Date.now()}`);
      const expected = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a]);
      await fs.ensureDir(repoDir);

      try {
        await execGit(['init'], repoDir);
        await fs.writeFile(path.join(repoDir, 'binary.bin'), expected);
        const blob = await execGit(['hash-object', '-w', 'binary.bin'], repoDir);

        const result = await execGitBuffer(['cat-file', '-p', blob], repoDir);

        expect(result).toEqual(expected);
      } finally {
        await fs.remove(repoDir);
      }
    });

    it('should read blobs larger than the previous 20 MiB limit', async () => {
      const repoDir = path.join(os.tmpdir(), `exec-git-large-buffer-test-${Date.now()}`);
      const expected = Buffer.alloc(21 * 1024 * 1024, 0xa5);
      await fs.ensureDir(repoDir);

      try {
        await execGit(['init'], repoDir);
        await fs.writeFile(path.join(repoDir, 'large.bin'), expected);
        const blob = await execGit(['hash-object', '-w', 'large.bin'], repoDir);

        const result = await execGitBuffer(['cat-file', '-p', blob], repoDir);

        expect(result.byteLength).toBe(expected.byteLength);
        expect(result[0]).toBe(0xa5);
        expect(result[result.length - 1]).toBe(0xa5);
      } finally {
        await fs.remove(repoDir);
      }
    });
  });

  describe('resolvePathWithinRoot', () => {
    let rootDir: string;

    beforeEach(async () => {
      rootDir = path.join(os.tmpdir(), `safe-path-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await fs.ensureDir(rootDir);
    });

    afterEach(async () => {
      await fs.remove(rootDir);
    });

    it('should resolve a repository-relative path', async () => {
      await expect(resolvePathWithinRoot(rootDir, 'docs/file.txt', 'Source')).resolves.toBe(
        path.resolve(rootDir, 'docs/file.txt')
      );
    });

    it('should reject traversal outside the repository root', async () => {
      await expect(resolvePathWithinRoot(rootDir, '../outside.txt', 'Destination')).rejects.toThrow(
        'escapes the repository root'
      );
    });

    it('should reject absolute paths', async () => {
      await expect(resolvePathWithinRoot(rootDir, path.resolve(rootDir, 'file.txt'), 'Source')).rejects.toThrow(
        'must be relative'
      );
    });

    it('should reject Git metadata paths', async () => {
      await expect(resolvePathWithinRoot(rootDir, '.git/config', 'Destination')).rejects.toThrow(
        'cannot target Git metadata'
      );
    });
  });

  describe('addTrailingSlash', () => {
    it('should add trailing slash when missing', () => {
      expect(addTrailingSlash('/path/to/dir')).toBe('/path/to/dir/');
    });

    it('should not add trailing slash when already present', () => {
      expect(addTrailingSlash('/path/to/dir/')).toBe('/path/to/dir/');
    });

    it('should handle empty string', () => {
      expect(addTrailingSlash('')).toBe('/');
    });

    it('should handle single character', () => {
      expect(addTrailingSlash('a')).toBe('a/');
    });

    it('should handle root path', () => {
      expect(addTrailingSlash('/')).toBe('/');
    });
  });

  describe('pathIsDirectory', () => {
    let tempDir: string;
    let tempFile: string;

    beforeAll(async () => {
      tempDir = path.join(os.tmpdir(), `test-dir-${Date.now()}`);
      tempFile = path.join(tempDir, 'test-file.txt');

      await fs.ensureDir(tempDir);
      await fs.writeFile(tempFile, 'test content');
    });

    afterAll(async () => {
      await fs.remove(tempDir);
    });

    it('should return true for directories', async () => {
      const result = await pathIsDirectory(tempDir);

      expect(result).toBe(true);
    });

    it('should return false for files', async () => {
      const result = await pathIsDirectory(tempFile);

      expect(result).toBe(false);
    });

    it('should throw for non-existent paths', async () => {
      await expect(pathIsDirectory('/non/existent/path/12345')).rejects.toThrow();
    });
  });

  describe('arrayEquals', () => {
    it('should return true for equal arrays', () => {
      expect(arrayEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    it('should return false for different arrays', () => {
      expect(arrayEquals([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(arrayEquals([1, 2], [1, 2, 3])).toBe(false);
    });

    it('should return true for empty arrays', () => {
      expect(arrayEquals([], [])).toBe(true);
    });

    it('should return false if first is not array', () => {
      expect(arrayEquals(null as unknown as unknown[], [])).toBe(false);
    });

    it('should return false if second is not array', () => {
      expect(arrayEquals([], null as unknown as unknown[])).toBe(false);
    });

    it('should work with string arrays', () => {
      expect(arrayEquals(['a', 'b'], ['a', 'b'])).toBe(true);
      expect(arrayEquals(['a', 'b'], ['a', 'c'])).toBe(false);
    });

    it('should compare by reference for objects', () => {
      const obj = { a: 1 };
      expect(arrayEquals([obj], [obj])).toBe(true);
      expect(arrayEquals([{ a: 1 }], [{ a: 1 }])).toBe(false); // Different references
    });

    it('should handle undefined values', () => {
      expect(arrayEquals([undefined], [undefined])).toBe(true);
      expect(arrayEquals([undefined], [null as unknown as undefined])).toBe(false);
    });
  });

  describe('remove', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = path.join(os.tmpdir(), `test-remove-${Date.now()}`);
      await fs.ensureDir(tempDir);
    });

    afterEach(async () => {
      try {
        await fs.remove(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should remove a file', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      await remove(filePath);

      expect(await fs.pathExists(filePath)).toBe(false);
    });

    it('should remove a directory', async () => {
      const dirPath = path.join(tempDir, 'subdir');
      await fs.ensureDir(dirPath);

      await remove(dirPath);

      expect(await fs.pathExists(dirPath)).toBe(false);
    });

    it('should remove a directory with contents', async () => {
      const dirPath = path.join(tempDir, 'subdir');
      const filePath = path.join(dirPath, 'file.txt');
      await fs.ensureDir(dirPath);
      await fs.writeFile(filePath, 'content');

      await remove(dirPath);

      expect(await fs.pathExists(dirPath)).toBe(false);
    });

    it('should not throw for non-existent paths', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist');

      await expect(remove(nonExistent)).resolves.toBeUndefined();
    });
  });
});

// Import readFilesRecursive for direct testing
import { readFilesRecursive } from '../src/helpers.js';

describe('helpers.ts - readFilesRecursive', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `test-readfiles-${Date.now()}`);
    await fs.ensureDir(tempDir);
  });

  afterEach(async () => {
    try {
      await fs.remove(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should list all files in directory', async () => {
    await fs.writeFile(path.join(tempDir, 'file1.txt'), 'content1');
    await fs.writeFile(path.join(tempDir, 'file2.txt'), 'content2');

    const files = await readFilesRecursive(tempDir);

    expect(files).toHaveLength(2);
    expect(files).toContain('file1.txt');
    expect(files).toContain('file2.txt');
  });

  it('should list files in subdirectories', async () => {
    await fs.ensureDir(path.join(tempDir, 'subdir'));
    await fs.writeFile(path.join(tempDir, 'root.txt'), 'root');
    await fs.writeFile(path.join(tempDir, 'subdir', 'nested.txt'), 'nested');

    const files = await readFilesRecursive(tempDir);

    expect(files).toHaveLength(2);
    expect(files).toContain('root.txt');
    expect(files).toContain('subdir/nested.txt');
  });

  it('should skip hidden files when includeHidden is false', async () => {
    await fs.writeFile(path.join(tempDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(tempDir, '.hidden'), 'hidden');

    const files = await readFilesRecursive(tempDir, false);

    expect(files).toHaveLength(1);
    expect(files).toContain('visible.txt');
    expect(files).not.toContain('.hidden');
  });

  it('should skip files in hidden directories when includeHidden is false', async () => {
    await fs.ensureDir(path.join(tempDir, '.hidden-dir'));
    await fs.writeFile(path.join(tempDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(tempDir, '.hidden-dir', 'file.txt'), 'hidden file');

    const files = await readFilesRecursive(tempDir, false);

    expect(files).toHaveLength(1);
    expect(files).toContain('visible.txt');
    // File in hidden directory should not appear
    expect(files.some(f => f.includes('.hidden-dir'))).toBe(false);
  });

  it('should include hidden files when includeHidden is true', async () => {
    await fs.writeFile(path.join(tempDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(tempDir, '.hidden'), 'hidden');

    const files = await readFilesRecursive(tempDir, true);

    expect(files).toHaveLength(2);
    expect(files).toContain('visible.txt');
    expect(files).toContain('.hidden');
  });

  it('should include files in hidden directories when includeHidden is true', async () => {
    await fs.ensureDir(path.join(tempDir, '.hidden-dir'));
    await fs.writeFile(path.join(tempDir, 'visible.txt'), 'visible');
    await fs.writeFile(path.join(tempDir, '.hidden-dir', 'file.txt'), 'hidden file');

    const files = await readFilesRecursive(tempDir, true);

    expect(files).toHaveLength(2);
    expect(files.some(f => f.includes('.hidden-dir'))).toBe(true);
  });

  it('should return empty array for empty directory', async () => {
    const files = await readFilesRecursive(tempDir);

    expect(files).toEqual([]);
  });

  it('should normalize path separators to forward slashes', async () => {
    await fs.ensureDir(path.join(tempDir, 'a', 'b'));
    await fs.writeFile(path.join(tempDir, 'a', 'b', 'file.txt'), 'content');

    const files = await readFilesRecursive(tempDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toBe('a/b/file.txt');
    expect(files[0]).not.toContain('\\');
  });

  it('should only include files, not directories', async () => {
    await fs.ensureDir(path.join(tempDir, 'emptydir'));
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');

    const files = await readFilesRecursive(tempDir);

    expect(files).toHaveLength(1);
    expect(files).toContain('file.txt');
    // Empty directory should not appear
    expect(files).not.toContain('emptydir');
  });

  it.skipIf(process.platform === 'win32')('should include symbolic links without traversing them', async () => {
    await fs.writeFile(path.join(tempDir, 'target.txt'), 'content');
    await fs.symlink('target.txt', path.join(tempDir, 'link.txt'));

    const files = await readFilesRecursive(tempDir);

    expect(files).toContain('target.txt');
    expect(files).toContain('link.txt');
  });
});

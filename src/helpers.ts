import fs from 'fs-extra';
import { readdir } from 'fs/promises';
import { exec } from 'child_process';
import * as core from '@actions/core';
import * as path from 'path';
import nunjucks from 'nunjucks';
import { Minimatch } from 'minimatch';

import type { ForEachCallback, FileConfig, RepoInfo, RepoConfig } from './types.js';

/**
 * Recursively reads all files in a directory, returning relative paths
 * Native replacement for node-readfiles
 * @internal Exported for testing
 */
export async function readFilesRecursive(dir: string, includeHidden = false): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    // Skip directories, only include files
    if (!entry.isFile()) {
      continue;
    }

    // Get relative path from the entry
    const relativePath = entry.parentPath ? path.relative(dir, path.join(entry.parentPath, entry.name)) : entry.name;

    // Skip hidden files/directories if not including them
    if (!includeHidden) {
      const parts = relativePath.split(path.sep);
      if (parts.some((part: string) => part.startsWith('.'))) {
        continue;
      }
    }

    // Normalize path separators to forward slashes for consistency
    files.push(relativePath.replace(/\\/g, '/'));
  }

  return files;
}

// Configure nunjucks
nunjucks.configure({ autoescape: true, trimBlocks: true, lstripBlocks: true });

/**
 * Async forEach utility - processes array items sequentially
 * From https://github.com/toniov/p-iteration/blob/master/lib/static-methods.js - MIT © Antonio V
 */
export async function forEach<T>(array: T[], callback: ForEachCallback<T>): Promise<void> {
  for (let index = 0; index < array.length; index++) {
    const item = array[index];
    if (item !== undefined) {
      await callback(item, index, array);
    }
  }
}

/**
 * Template literal tag that removes leading indentation from multiline strings
 * From https://github.com/MartinKolarik/dedent-js/blob/master/src/index.ts - MIT © 2015 Martin Kolárik
 */
export function dedent(templateStrings: TemplateStringsArray | string, ...values: unknown[]): string {
  const matches: string[] = [];
  const strings: string[] = typeof templateStrings === 'string' ? [templateStrings] : [...templateStrings];

  // Remove trailing whitespace from last string
  const lastIndex = strings.length - 1;
  const lastString = strings[lastIndex];
  if (lastString !== undefined) {
    strings[lastIndex] = lastString.replace(/\r?\n([\t ]*)$/, '');
  }

  for (let i = 0; i < strings.length; i++) {
    const str = strings[i];
    if (str !== undefined) {
      const match = str.match(/\n[\t ]+/g);
      if (match) {
        matches.push(...match);
      }
    }
  }

  if (matches.length) {
    const size = Math.min(...matches.map((value) => value.length - 1));
    const pattern = new RegExp(`\n[\t ]{${size}}`, 'g');
    for (let i = 0; i < strings.length; i++) {
      const str = strings[i];
      if (str !== undefined) {
        strings[i] = str.replace(pattern, '\n');
      }
    }
  }

  const firstString = strings[0];
  if (firstString !== undefined) {
    strings[0] = firstString.replace(/^\r?\n/, '');
  }

  let result = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    result += String(values[i]) + (strings[i + 1] ?? '');
  }

  return result;
}

/**
 * Execute a shell command and return the output
 */
export function execCmd(command: string, workingDir?: string, trimResult = true): Promise<string> {
  core.debug(`EXEC: "${command}" IN ${workingDir ?? 'default'}`);

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: workingDir,
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(trimResult ? stdout.trim() : stdout);
        }
      }
    );
  });
}

/**
 * Adds a trailing slash to a path if it doesn't have one
 */
export function addTrailingSlash(str: string): string {
  return str.endsWith('/') ? str : str + '/';
}

/**
 * Checks if a path is a directory
 */
export async function pathIsDirectory(filePath: string): Promise<boolean> {
  const stat = await fs.lstat(filePath);
  return stat.isDirectory();
}

/**
 * Renders a nunjucks template file to a destination
 */
export async function write(
  src: string,
  dest: string,
  context: Record<string, unknown> = {},
  repo?: RepoInfo
): Promise<void> {
  const templateContext = typeof context === 'object' ? context : {};

  // Include current repo constants (e.g., host, user, name, branch, etc.)
  if (repo) {
    templateContext['repo'] = repo;
  }

  const content = nunjucks.render(src, templateContext);
  await fs.outputFile(dest, content);
}

/**
 * Creates a filter function for file copying based on exclusion rules
 */
function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}

function normalizePattern(pattern: string, sourceRoot: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) return '';

  const posixPattern = toPosix(trimmed).replace(/^\.\//, '');
  const normalizedSource = toPosix(sourceRoot).replace(/\/+$/, '');

  if (posixPattern.startsWith(`${normalizedSource}/`)) {
    return posixPattern.slice(normalizedSource.length + 1);
  }

  return posixPattern;
}

function buildMatcher(patterns: string[] | undefined, sourceRoot: string): ((target: string) => boolean) | undefined {
  if (!patterns || patterns.length === 0) {
    return undefined;
  }

  const normalized = patterns
    .map((pattern) => normalizePattern(pattern, sourceRoot))
    .filter((pattern) => pattern.length > 0);

  if (normalized.length === 0) {
    return undefined;
  }

  const matchers = normalized.map((pattern) => {
    const patternToUse = pattern.endsWith('/') ? `${pattern}**` : pattern;
    return new Minimatch(patternToUse, { dot: false });
  });
  return (target: string): boolean => matchers.some((matcher) => matcher.match(target));
}

/**
 * Creates a filter function for file copying based on exclusion rules.
 * @internal Exported for unit testing
 */
export function createFilterFunc(
  sourceRoot: string,
  exclude: string[] | undefined,
  include: string[] | undefined
): (file: string) => boolean {
  const root = path.resolve(sourceRoot);
  const compiledExclude = buildMatcher(exclude, root);
  const compiledInclude = buildMatcher(include, root);

  return (filePath: string): boolean => {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
    const relative = toPosix(path.relative(root, absolutePath));
    const basename = path.posix.basename(relative);
    const candidates = relative ? [relative, basename] : [basename];

    if (relative.startsWith('..')) {
      return true; // Do not filter files outside the source root
    }

    // Always allow directories so traversal continues; filtering applies to files
    try {
      if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory()) {
        return true;
      }
    } catch {
      // If stat fails, fall through to pattern checks
    }

    if (compiledInclude && !candidates.some((candidate) => compiledInclude(candidate))) {
      core.debug(`Excluding ${relative} because it did not match include patterns`);
      return false;
    }
    const isExcluded = compiledExclude ? candidates.some((candidate) => compiledExclude(candidate)) : false;

    if (isExcluded) {
      core.debug(`Excluding ${relative} because it matched exclude patterns`);
      return false;
    }

    return true;
  };
}

/**
 * Copies files from source to destination, with support for templates and exclusions
 */
export async function copy(
  src: string,
  dest: string,
  isDirectory: boolean,
  file: FileConfig,
  item: RepoConfig
): Promise<void> {
  const deleteOrphaned = isDirectory && file.deleteOrphaned;
  const { exclude, template, replace } = file;
  const filterFunc = createFilterFunc(src, exclude, file.include);
  const shouldFilter = exclude !== undefined || file.include !== undefined;

  const shouldSkipDest = async (destPath: string): Promise<boolean> => {
    if (replace !== false) {
      return false;
    }
    return fs.pathExists(destPath);
  };

  if (template) {
    const templateContext = typeof template === 'object' ? template : {};

    if (isDirectory) {
      core.debug(`Render all files in directory ${src} to ${dest}`);

      const srcFileList = await readFilesRecursive(src, true);

      for (const srcFile of srcFileList) {
        const absoluteSrc = path.join(src, srcFile);
        if (!filterFunc(absoluteSrc)) {
          continue;
        }

        const srcPath = absoluteSrc;
        const destPath = path.join(dest, srcFile);

        // Per-file replace: skip rendering if destination file already exists
        if (await shouldSkipDest(destPath)) {
          core.debug(`Skipping ${destPath} because replace is false and destination exists`);
          continue;
        }

        await write(srcPath, destPath, templateContext, item.repo);
      }
    } else {
      core.debug(`Render file ${src} to ${dest}`);
      if (filterFunc(src)) {
        if (await shouldSkipDest(dest)) {
          core.debug(`Skipping ${dest} because replace is false and destination exists`);
          return;
        }
        await write(src, dest, templateContext, item.repo);
      }
    }
  } else {
    core.debug(`Copy ${src} to ${dest}`);

    if (!isDirectory) {
      if (await shouldSkipDest(dest)) {
        core.debug(`Skipping ${dest} because replace is false and destination exists`);
        return;
      }

      await fs.copy(src, dest, shouldFilter ? { filter: filterFunc } : undefined);
    } else if (replace === false) {
      // Per-file replace for directories: copy new files, but don't overwrite existing ones
      const files = await readFilesRecursive(src, true);

      for (const relativeFile of files) {
        const absoluteSrc = path.join(src, relativeFile);
        if (shouldFilter && !filterFunc(absoluteSrc)) {
          continue;
        }

        const absoluteDest = path.join(dest, relativeFile);
        if (await shouldSkipDest(absoluteDest)) {
          core.debug(`Skipping ${absoluteDest} because replace is false and destination exists`);
          continue;
        }

        await fs.ensureDir(path.dirname(absoluteDest));
        await fs.copyFile(absoluteSrc, absoluteDest);
      }
    } else if (shouldFilter) {
      const files = await readFilesRecursive(src, true);

      for (const relativeFile of files) {
        const absoluteSrc = path.join(src, relativeFile);
        if (!filterFunc(absoluteSrc)) {
          continue;
        }

        const absoluteDest = path.join(dest, relativeFile);
        await fs.ensureDir(path.dirname(absoluteDest));
        await fs.copyFile(absoluteSrc, absoluteDest);
      }
    } else {
      await fs.copy(src, dest);
    }
  }

  // If it is a directory and deleteOrphaned is enabled - check for orphaned files
  if (deleteOrphaned) {
    const srcFileList = await readFilesRecursive(src, true);
    const destFileList = await readFilesRecursive(dest, true);

    const isInScope = (relativePath: string): boolean => {
      if (!shouldFilter) {
        return true;
      }
      // Evaluate filter against the corresponding path under the source root.
      return filterFunc(path.join(src, relativePath));
    };

    // Only files that would be copied/rendered are considered "in scope" for orphan deletion.
    // Files filtered out by include/exclude are preserved.
    const shouldExist = new Set(srcFileList.filter((filePath) => isInScope(filePath)));

    let skipGitDir = false;

    for (const destFile of destFileList) {
      // Skip files under .git directory (use forward slash since readFilesRecursive normalizes paths)
      if (destFile.startsWith('.git/') || destFile === '.git') {
        if (!skipGitDir) {
          core.debug('Skipping files under .git directory');
          skipGitDir = true;
        }
        continue;
      }

      // Preserve out-of-scope files (excluded/not-included)
      if (!isInScope(destFile)) {
        continue;
      }

      if (!shouldExist.has(destFile)) {
        const filePath = path.join(dest, destFile);
        core.debug(`Found an orphaned file in the target repo - ${filePath}`);
        core.debug(`Removing file ${destFile}`);
        await fs.remove(filePath);
      }
    }
  }
}

/**
 * Removes a file or directory
 */
export async function remove(src: string): Promise<void> {
  core.debug(`RM: ${src}`);
  await fs.remove(src);
}

/**
 * Compares two arrays for equality
 */
export function arrayEquals<T>(array1: T[], array2: T[]): boolean {
  return (
    Array.isArray(array1) &&
    Array.isArray(array2) &&
    array1.length === array2.length &&
    array1.every((value, i) => value === array2[i])
  );
}

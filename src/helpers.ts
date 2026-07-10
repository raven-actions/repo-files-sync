import fs from 'fs-extra';
import { readdir } from 'fs/promises';
import { execFile } from 'child_process';
import * as core from '@actions/core';
import * as path from 'path';
import nunjucks from 'nunjucks';
import { Minimatch } from 'minimatch';

import type { ForEachCallback, FileConfig, RepoInfo, RepoConfig } from './types.js';

/**
 * Recursively reads all files and symbolic links in a directory, returning relative paths
 * Native replacement for node-readfiles
 * @internal Exported for testing
 */
export async function readFilesRecursive(dir: string, includeHidden = false): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    // Get relative path from the entry
    const relativePath = path.relative(dir, path.join(entry.parentPath, entry.name));

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
  strings[lastIndex] = strings[lastIndex]!.replace(/\r?\n([\t ]*)$/, '');

  for (const str of strings) {
    const match = str.match(/\n[\t ]+/g);
    if (match) {
      matches.push(...match);
    }
  }

  if (matches.length) {
    const size = Math.min(...matches.map((value) => value.length - 1));
    const pattern = new RegExp(`\n[\t ]{${size}}`, 'g');
    for (let i = 0; i < strings.length; i++) {
      strings[i] = strings[i]!.replace(pattern, '\n');
    }
  }

  strings[0] = strings[0]!.replace(/^\r?\n/, '');

  let result = strings[0]!;
  for (let i = 0; i < values.length; i++) {
    result += String(values[i]) + strings[i + 1]!;
  }

  return result;
}

/**
 * Execute a git command without shell interpolation and return the output
 */
export function execGit(args: string[], workingDir?: string, trimResult = true): Promise<string> {
  const printableArgs = args.map((arg) => JSON.stringify(arg)).join(' ');
  core.debug(`EXEC: "git ${printableArgs}" IN ${workingDir ?? 'default'}`);

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
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
 * Execute a git command and return its output without text decoding
 */
export function execGitBuffer(args: string[], workingDir?: string): Promise<Buffer> {
  const printableArgs = args.map((arg) => JSON.stringify(arg)).join(' ');
  core.debug(`EXEC: "git ${printableArgs}" IN ${workingDir ?? 'default'}`);

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: workingDir,
        maxBuffer: 1024 * 1024 * 101,
        encoding: 'buffer'
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
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

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve a repository-relative path and reject traversal, Git metadata, and
 * existing symlink ancestors that escape the repository root.
 */
export async function resolvePathWithinRoot(root: string, input: string, label: string): Promise<string> {
  if (!input || path.isAbsolute(input)) {
    throw new Error(`${label} path "${input}" must be relative to the repository root`);
  }

  const absoluteRoot = path.resolve(root);
  const resolvedPath = path.resolve(absoluteRoot, input);

  if (!isPathWithinRoot(absoluteRoot, resolvedPath)) {
    throw new Error(`${label} path "${input}" escapes the repository root`);
  }

  const relativeSegments = path.relative(absoluteRoot, resolvedPath).split(path.sep);
  if (relativeSegments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`${label} path "${input}" cannot target Git metadata`);
  }

  let existingPath = resolvedPath;
  while (existingPath !== absoluteRoot) {
    try {
      await fs.lstat(existingPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      existingPath = path.dirname(existingPath);
    }
  }

  try {
    const [realRoot, realExistingPath] = await Promise.all([fs.realpath(absoluteRoot), fs.realpath(existingPath)]);
    if (!isPathWithinRoot(realRoot, realExistingPath)) {
      throw new Error(`${label} path "${input}" escapes the repository root through a symbolic link`);
    }
  } catch (error) {
    if ((error as Error).message.includes('escapes the repository root')) {
      throw error;
    }
    throw new Error(`${label} path "${input}" contains an invalid symbolic link`, { cause: error });
  }

  return resolvedPath;
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
  const templateContext = context;

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

  const posixPattern = toPosix(trimmed);
  const negated = posixPattern.startsWith('!');
  const patternBody = (negated ? posixPattern.slice(1) : posixPattern).replace(/^\.\//, '');
  const normalizedSource = toPosix(sourceRoot).replace(/\/+$/, '');

  if (patternBody.startsWith(`${normalizedSource}/`)) {
    const relativePattern = patternBody.slice(normalizedSource.length + 1);
    return negated ? `!${relativePattern}` : relativePattern;
  }

  return negated ? `!${patternBody}` : patternBody;
}

function buildMatcher(patterns: string[] | undefined, sourceRoot: string): ((targets: string[]) => boolean) | undefined {
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
    const negated = pattern.startsWith('!');
    const patternBody = negated ? pattern.slice(1) : pattern;
    const patternToUse = patternBody.endsWith('/') ? `${patternBody}**` : patternBody;
    return { negated, matcher: new Minimatch(patternToUse, { dot: false, nonegate: true }) };
  });
  const positiveMatchers = matchers.filter(({ negated }) => !negated);
  const negativeMatchers = matchers.filter(({ negated }) => negated);

  return (targets: string[]): boolean => {
    const matchesPositive =
      positiveMatchers.length === 0 ||
      positiveMatchers.some(({ matcher }) => targets.some((target) => matcher.match(target)));
    const matchesNegative = negativeMatchers.some(({ matcher }) => targets.some((target) => matcher.match(target)));
    return matchesPositive && !matchesNegative;
  };
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
    const segments = relative.split('/').filter((segment) => segment.length > 0);
    const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
    const candidates = [...new Set([relative, basename, ...segments, ...ancestors].filter((candidate) => candidate.length > 0))];

    if (relative === '..' || relative.startsWith('../')) {
      return true; // Do not filter files outside the source root
    }

    if (segments.some((segment) => segment.toLowerCase() === '.git')) {
      core.debug(`Excluding ${relative} because Git metadata cannot be copied`);
      return false;
    }

    // Always allow directories so traversal continues; filtering applies to files
    try {
      if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory()) {
        return true;
      }
    } catch {
      // If stat fails, fall through to pattern checks
    }

    if (compiledInclude && !compiledInclude(candidates)) {
      core.debug(`Excluding ${relative} because it did not match include patterns`);
      return false;
    }
    const isExcluded = compiledExclude ? compiledExclude(candidates) : false;

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
  const shouldFilter = isDirectory || exclude !== undefined || file.include !== undefined;

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

        const sourceStat = await fs.lstat(srcPath);
        if (sourceStat.isSymbolicLink()) {
          await fs.ensureDir(path.dirname(destPath));
          await fs.copy(srcPath, destPath, { dereference: false });
        } else {
          await write(srcPath, destPath, templateContext, item.repo);
        }
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
        if (!filterFunc(absoluteSrc)) {
          continue;
        }

        const absoluteDest = path.join(dest, relativeFile);
        if (await shouldSkipDest(absoluteDest)) {
          core.debug(`Skipping ${absoluteDest} because replace is false and destination exists`);
          continue;
        }

        await fs.ensureDir(path.dirname(absoluteDest));
        await fs.copy(absoluteSrc, absoluteDest, { dereference: false });
      }
    } else {
      await fs.copy(src, dest, { filter: filterFunc });
    }
  }

  // If it is a directory and deleteOrphaned is enabled - check for orphaned files
  if (deleteOrphaned) {
    const srcFileList = await readFilesRecursive(src, true);
    const destFileList = await readFilesRecursive(dest, true);

    const isInScope = (relativePath: string): boolean => {
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

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
 * `excludeAbsolutePaths` skips any entry that is, or lives inside, one of
 * those paths (e.g. this action's own TMP_DIR working directory when it
 * happens to fall inside the directory being read).
 * @internal Exported for testing
 */
export async function readFilesRecursive(
  dir: string,
  includeHidden = false,
  excludeAbsolutePaths: string[] = []
): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    const entryAbsolutePath = path.join(entry.parentPath, entry.name);

    if (excludeAbsolutePaths.some((excluded) => isPathWithinRoot(excluded, entryAbsolutePath))) {
      continue;
    }

    // Get relative path from the entry
    const relativePath = path.relative(dir, entryAbsolutePath);

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
 * Reconfigure the shared Nunjucks environment's `autoescape` option. Defaults
 * to `true` (unchanged behavior); set to `false` for source files that are
 * not HTML/XML (e.g. YAML, shell scripts) where autoescaping would otherwise
 * corrupt content such as replacing `'` with `&#39;` - see
 * https://github.com/BetaHuhn/repo-file-sync-action/issues/278.
 * @internal Exported for testing
 */
export function configureTemplateAutoescape(enabled: boolean): void {
  nunjucks.configure({ autoescape: enabled, trimBlocks: true, lstripBlocks: true });
}

// --- Template execution sandbox --------------------------------------------
//
// Nunjucks explicitly does not sandbox template execution (see its own
// "User-Defined Templates Warning":
// https://mozilla.github.io/nunjucks/api.html#user-defined-templates-warning).
// The standard way template syntax escalates into arbitrary JavaScript
// execution is a property-access chain that reaches a constructor, e.g.
// `{{ "".constructor.constructor("<code>")() }}` or
// `{{ range.constructor("<code>")() }}`.
//
// Every `.attr` and `[expr]` access a compiled Nunjucks template can perform -
// on any object, including string/array/number literals - is compiled down to
// a call to a single runtime function, `memberLookup`
// (nunjucks/src/runtime.js). That function is passed by reference into every
// compiled template's root render function (nunjucks/src/environment.js), and
// `nunjucks.runtime` is that exact same module-level object, so patching the
// property here blocks the chain for every template rendered anywhere in this
// process, regardless of which Environment/context renders it.
//
// This is a best-effort mitigation, not a full sandbox: it does not limit the
// CPU/memory usage of a runaway template, and it relies on an internal (but
// verified against the pinned nunjucks version) entry point rather than a
// documented public API, since Nunjucks does not expose one for this. Only
// ever enable `template` on files whose full content you trust, regardless of
// this setting - see the README's "Using templates" section and SECURITY.md.
type MemberLookup = (obj: unknown, key: unknown) => unknown;

interface NunjucksRuntimeInternals {
  memberLookup: MemberLookup;
}

const FORBIDDEN_TEMPLATE_KEYS = new Set([
  'constructor',
  'prototype',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__'
]);

let originalMemberLookup: MemberLookup | undefined;

/**
 * Enable or disable the template execution sandbox described above. Blocks
 * property-access chains that reach `constructor`/`__proto__`/`prototype`
 * (and the legacy dunder accessor methods) while templates render, so that
 * e.g. `{{ "".constructor.constructor("...")() }}` resolves to `undefined`
 * instead of the `Function` constructor.
 *
 * Applies process-wide (Nunjucks shares one runtime module across every
 * Environment) and is idempotent - safe to call repeatedly/in any order.
 * @internal Exported for testing
 */
export function configureTemplateSandbox(enabled: boolean): void {
  const runtimeModule = (nunjucks as unknown as { runtime: NunjucksRuntimeInternals }).runtime;

  originalMemberLookup ??= runtimeModule.memberLookup;
  const baseline = originalMemberLookup;

  runtimeModule.memberLookup = enabled ?
    (obj: unknown, key: unknown): unknown => {
      if (typeof key === 'string' && FORBIDDEN_TEMPLATE_KEYS.has(key)) {
        return undefined;
      }
      return baseline(obj, key);
    }
  : baseline;
}

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

/**
 * Returns true when `candidate` is `root` itself or lives somewhere inside it.
 * @internal Exported for testing and reuse (e.g. index.ts's TMP_DIR guard)
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
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

  const matchers = normalized.flatMap((pattern) => {
    const negated = pattern.startsWith('!');
    const patternBody = negated ? pattern.slice(1) : pattern;

    if (patternBody.endsWith('/')) {
      // A trailing-slash "directory" pattern (e.g. `subdir/`) should match
      // the directory itself - not just descendants matched via `subdir/**`
      // below - so that checking the directory's own path (see
      // createFilterFunc's directory handling) also prunes it. Minimatch's
      // `dir/**` does not match the bare `dir` on its own, hence the
      // separate matcher for the trimmed form.
      const bare = patternBody.slice(0, -1);
      return [
        { negated, matcher: new Minimatch(bare, { dot: false, nonegate: true }) },
        { negated, matcher: new Minimatch(`${patternBody}**`, { dot: false, nonegate: true }) }
      ];
    }

    return [{ negated, matcher: new Minimatch(patternBody, { dot: false, nonegate: true }) }];
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

    let isDirectory = false;
    try {
      isDirectory = fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory();
    } catch {
      // If stat fails, treat as a file and fall through to pattern checks
    }

    if (isDirectory) {
      // A directory can't itself "match" an include pattern (only files can),
      // so keep traversing into it by default - files deeper inside may still
      // match. But an explicit exclude match on the directory's own path
      // prunes the whole subtree (matching exclude's "skip this and
      // everything inside" intent) instead of only filtering the files
      // inside one by one, which would still traverse (and copy an empty
      // directory for) the excluded subtree.
      const isExcluded = compiledExclude ? compiledExclude(candidates) : false;
      if (isExcluded) {
        core.debug(`Excluding ${relative} because it matched exclude patterns`);
        return false;
      }
      return true;
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
 * Copies `src` to `dest` like a recursive, filtered `fs.copy`, except any
 * entry that is (or contains) one of `excludeAbsolutePaths` is skipped
 * instead of copied.
 *
 * This is needed whenever `dest` could be a descendant of one of those paths
 * (most notably this action's own TMP_DIR nested inside a directory sync's
 * `source`, e.g. `source: ./`): fs-extra's `copy()` rejects `dest` being a
 * subdirectory of `src` *before* the filter function is ever consulted (see
 * fs-extra's `stat.checkPaths`), so no filter/exclude pattern can prevent
 * that failure - and `createFilterFunc` deliberately always allows
 * traversal into non-excluded directories, so filtering alone can't stop
 * fs-extra from recursing into an excluded one either. Copying each
 * top-level entry individually - and only manually recursing into the
 * specific branch that leads to an excluded path, letting fs-extra handle
 * every other entry as usual - means `dest` is never passed as a
 * subdirectory of any `src` argument fs.copy actually sees. See
 * https://github.com/BetaHuhn/repo-file-sync-action/issues/348 and
 * https://github.com/BetaHuhn/repo-file-sync-action/issues/322.
 * @internal Exported for testing
 */
export async function copyDirectoryExcludingPaths(
  src: string,
  dest: string,
  filterFunc: (file: string) => boolean,
  excludeAbsolutePaths: string[]
): Promise<void> {
  await fs.ensureDir(dest);

  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const entrySrc = path.join(src, entry.name);

    if (excludeAbsolutePaths.some((excluded) => isPathWithinRoot(excluded, entrySrc))) {
      core.debug(`Skipping ${entrySrc} (this action's own working directory)`);
      continue;
    }

    if (!filterFunc(entrySrc)) {
      continue;
    }

    const entryDest = path.join(dest, entry.name);

    if (entry.isDirectory() && excludeAbsolutePaths.some((excluded) => isPathWithinRoot(entrySrc, excluded))) {
      // This branch leads down to an excluded path - keep recursing manually
      // instead of handing it to fs.copy, which would eventually see `dest`
      // as a subdirectory of it once we reach the excluded path's parent.
      await copyDirectoryExcludingPaths(entrySrc, entryDest, filterFunc, excludeAbsolutePaths);
    } else {
      await fs.copy(entrySrc, entryDest, { filter: filterFunc });
    }
  }
}

/**
 * Copies files from source to destination, with support for templates and exclusions
 */
export async function copy(
  src: string,
  dest: string,
  isDirectory: boolean,
  file: FileConfig,
  item: RepoConfig,
  excludeAbsolutePaths: string[] = []
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

      const srcFileList = await readFilesRecursive(src, true, excludeAbsolutePaths);

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
      const files = await readFilesRecursive(src, true, excludeAbsolutePaths);

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
    } else if (excludeAbsolutePaths.length > 0) {
      await copyDirectoryExcludingPaths(src, dest, filterFunc, excludeAbsolutePaths);
    } else {
      await fs.copy(src, dest, { filter: filterFunc });
    }
  }

  // If it is a directory and deleteOrphaned is enabled - check for orphaned files
  if (deleteOrphaned) {
    const srcFileList = await readFilesRecursive(src, true, excludeAbsolutePaths);
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

import fs from 'fs-extra';
import { readdir } from 'fs/promises';
import { exec } from 'child_process';
import * as core from '@actions/core';
import * as path from 'path';
import nunjucks from 'nunjucks';

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
        maxBuffer: 1024 * 1024 * 4
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
function createFilterFunc(exclude: string[] | undefined): (file: string) => boolean {
  return (file: string): boolean => {
    if (exclude === undefined) {
      return true;
    }

    // Check if file-path is one of the present filepaths in the excluded paths
    let filePath = '';
    if (file.endsWith('/')) {
      filePath = file;
    } else {
      filePath = file.split('/').slice(0, -1).join('/') + '/';
    }

    if (exclude.includes(filePath)) {
      core.debug(`Excluding file ${file} since its path is included as one of the excluded paths.`);
      return false;
    }

    if (exclude.includes(file)) {
      core.debug(`Excluding file ${file} since it is explicitly added in the exclusion list.`);
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
  const { exclude, template } = file;
  const filterFunc = createFilterFunc(exclude);

  if (template) {
    const templateContext = typeof template === 'object' ? template : {};

    if (isDirectory) {
      core.debug(`Render all files in directory ${src} to ${dest}`);

      const srcFileList = await readFilesRecursive(src, true);

      for (const srcFile of srcFileList) {
        if (!filterFunc(srcFile)) {
          continue;
        }

        const srcPath = path.join(src, srcFile);
        const destPath = path.join(dest, srcFile);
        await write(srcPath, destPath, templateContext, item.repo);
      }
    } else {
      core.debug(`Render file ${src} to ${dest}`);
      await write(src, dest, templateContext, item.repo);
    }
  } else {
    core.debug(`Copy ${src} to ${dest}`);
    await fs.copy(src, dest, exclude !== undefined ? { filter: filterFunc } : undefined);
  }

  // If it is a directory and deleteOrphaned is enabled - check for orphaned files
  if (deleteOrphaned) {
    const srcFileList = await readFilesRecursive(src, true);
    const destFileList = await readFilesRecursive(dest, true);

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

      if (!srcFileList.includes(destFile)) {
        const filePath = path.join(dest, destFile);
        core.debug(`Found an orphaned file in the target repo - ${filePath}`);

        if (exclude !== undefined && exclude.includes(path.join(src, destFile))) {
          core.debug(`Excluding file ${destFile}`);
        } else {
          core.debug(`Removing file ${destFile}`);
          await fs.remove(filePath);
        }
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

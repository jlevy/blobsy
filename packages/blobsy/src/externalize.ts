/**
 * Externalization rules.
 *
 * Decide per-file whether to externalize (create .yref + gitignore) or leave in git.
 * Only applies to directory tracking -- explicit file tracking always externalizes.
 */

import picomatch from 'picomatch';

import type { ExternalizeConfig } from './types.js';
import { parseSize } from './config.js';

/**
 * Decide whether a file should be externalized based on config rules.
 *
 * Decision order:
 * 1. Check `never` patterns -- if match, keep in git
 * 2. Check `always` patterns -- if match, externalize
 * 3. Compare file size against `min_size`
 */
export function shouldExternalize(
  filePath: string,
  fileSize: number,
  config: ExternalizeConfig,
): boolean {
  const filename = filePath.split('/').pop() ?? filePath;

  if (config.never.length > 0) {
    const neverMatcher = picomatch(config.never);
    if (neverMatcher(filename) || neverMatcher(filePath)) {
      return false;
    }
  }

  if (config.always.length > 0) {
    const alwaysMatcher = picomatch(config.always);
    if (alwaysMatcher(filename) || alwaysMatcher(filePath)) {
      return true;
    }
  }

  const minSize = parseSize(config.min_size);
  return fileSize >= minSize;
}

/**
 * Filter a list of files, marking each as externalize or not.
 * Respects ignore patterns to skip files entirely.
 */
export function filterFilesForExternalization(
  files: { path: string; size: number }[],
  config: ExternalizeConfig,
  ignorePatterns: string[],
): { path: string; size: number; externalize: boolean }[] {
  const ignoreMatcher = ignorePatterns.length > 0 ? picomatch(ignorePatterns) : null;

  return files
    .filter((f) => {
      if (ignoreMatcher) {
        const filename = f.path.split('/').pop() ?? f.path;
        return !ignoreMatcher(filename) && !ignoreMatcher(f.path);
      }
      return true;
    })
    .map((f) => ({
      ...f,
      externalize: shouldExternalize(f.path, f.size, config),
    }));
}

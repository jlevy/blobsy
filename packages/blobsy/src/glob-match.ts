/**
 * Shared glob-matching utility for externalization and compression rules.
 */

import picomatch from 'picomatch';

/** Check if a file path matches any of the given glob patterns (by filename or full path). */
export function matchesGlobList(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const filename = filePath.split('/').pop() ?? filePath;
  const matcher = picomatch(patterns);
  return matcher(filename) || matcher(filePath);
}

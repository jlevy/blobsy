/**
 * Externalization rules.
 *
 * Decide per-file whether to externalize (create .bref + gitignore) or leave in git.
 * Only applies to directory tracking -- explicit file tracking always externalizes.
 */

import type { ExternalizeConfig } from './types.js';
import { parseSize } from './config.js';
import { matchesGlobList } from './glob-match.js';

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
  if (matchesGlobList(filePath, config.never)) {
    return false;
  }
  if (matchesGlobList(filePath, config.always)) {
    return true;
  }
  const minSize = parseSize(config.min_size);
  return fileSize >= minSize;
}

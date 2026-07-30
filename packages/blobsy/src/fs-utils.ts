/**
 * Filesystem utilities shared across modules.
 */

import { mkdir } from 'node:fs/promises';

/** Create directory and all parents if they don't exist. */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Platform-appropriate PATH lookup command: `where` on Windows, `which`
 * elsewhere (review finding BE-09). Every binary probe must use this — a
 * hardcoded `which` makes doctor/health checks fail on Windows for
 * commands that actually run fine.
 */
export function binaryLookupCommand(): string {
  return process.platform === 'win32' ? 'where' : 'which';
}

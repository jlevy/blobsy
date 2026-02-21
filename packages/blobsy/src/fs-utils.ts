/**
 * Filesystem utilities shared across modules.
 */

import { mkdir } from 'node:fs/promises';

/** Create directory and all parents if they don't exist. */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

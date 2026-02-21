/**
 * Local filesystem backend.
 *
 * Directory-to-directory file copy for dev/testing. Same interface as
 * cloud backends. Atomic downloads via temp-file-then-rename.
 */

import { copyFile, access, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { BlobsyError } from './types.js';
import { computeHash } from './hash.js';
import { ensureDir } from './fs-utils.js';

/** Push a local file to the local backend. */
export async function localPush(
  localPath: string,
  remoteDir: string,
  remoteKey: string,
): Promise<void> {
  const destPath = join(remoteDir, remoteKey);
  await ensureDir(dirname(destPath));
  await copyFile(localPath, destPath);
}

/** Pull a file from the local backend with atomic download and hash verification. */
export async function localPull(
  remoteDir: string,
  remoteKey: string,
  localPath: string,
  expectedHash?: string,
): Promise<void> {
  const srcPath = join(remoteDir, remoteKey);

  if (!existsSync(srcPath)) {
    throw new BlobsyError(`Remote blob not found: ${remoteKey}`, 'not_found', 1, [
      'Check that the file has been pushed to the remote.',
    ]);
  }

  // Atomic download: copy to temp, verify, rename
  const tmpSuffix = randomBytes(8).toString('hex');
  const tmpPath = `${localPath}.blobsy-tmp-${tmpSuffix}`;
  await ensureDir(dirname(localPath));

  try {
    await copyFile(srcPath, tmpPath);

    if (expectedHash) {
      const actualHash = await computeHash(tmpPath);
      if (actualHash !== expectedHash) {
        throw new BlobsyError(
          `Hash mismatch on pull: expected ${expectedHash}, got ${actualHash}`,
          'validation',
          1,
          ['The remote blob may be corrupted. Try pushing again.'],
        );
      }
    }

    await rename(tmpPath, localPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

/** Check if a blob exists in the local backend. */
export function localBlobExists(remoteDir: string, remoteKey: string): boolean {
  const blobPath = join(remoteDir, remoteKey);
  return existsSync(blobPath);
}

/** Verify the local backend directory is accessible and writable. */
export async function localHealthCheck(remoteDir: string): Promise<void> {
  try {
    await access(remoteDir);
  } catch {
    throw new BlobsyError(`Local backend directory not found: ${remoteDir}`, 'not_found', 1, [
      'Create the directory or check the path in .blobsy.yml.',
    ]);
  }

  // Verify writable by creating and removing a temp file
  const tmpFile = join(remoteDir, `.blobsy-health-check-${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(tmpFile, 'health-check');
    await unlink(tmpFile);
  } catch {
    throw new BlobsyError(
      `Local backend directory is not writable: ${remoteDir}`,
      'permission',
      1,
      ['Check filesystem permissions on the backend directory.'],
    );
  }
}

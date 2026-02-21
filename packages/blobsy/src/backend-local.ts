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

import type { Backend } from './types.js';
import { BlobsyError } from './types.js';
import { computeHash } from './hash.js';
import { ensureDir } from './fs-utils.js';

export class LocalBackend implements Backend {
  readonly type = 'local' as const;
  private readonly remoteDir: string;

  constructor(remoteDir: string) {
    this.remoteDir = remoteDir;
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    const destPath = join(this.remoteDir, remoteKey);
    await ensureDir(dirname(destPath));
    await copyFile(localPath, destPath);
  }

  async pull(remoteKey: string, localPath: string, expectedHash?: string): Promise<void> {
    const srcPath = join(this.remoteDir, remoteKey);

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
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }

  exists(remoteKey: string): Promise<boolean> {
    const blobPath = join(this.remoteDir, remoteKey);
    return Promise.resolve(existsSync(blobPath));
  }

  async healthCheck(): Promise<void> {
    try {
      await access(this.remoteDir);
    } catch {
      throw new BlobsyError(
        `Local backend directory not found: ${this.remoteDir}`,
        'not_found',
        1,
        ['Create the directory or check the path in .blobsy.yml.'],
      );
    }

    const tmpFile = join(this.remoteDir, `.blobsy-health-check-${randomBytes(4).toString('hex')}`);
    try {
      await writeFile(tmpFile, 'health-check');
      await unlink(tmpFile);
    } catch {
      throw new BlobsyError(
        `Local backend directory is not writable: ${this.remoteDir}`,
        'permission',
        1,
        ['Check filesystem permissions on the backend directory.'],
      );
    }
  }
}

// Legacy function exports for backward compatibility with existing tests
export async function localPush(
  localPath: string,
  remoteDir: string,
  remoteKey: string,
): Promise<void> {
  const backend = new LocalBackend(remoteDir);
  await backend.push(localPath, remoteKey);
}

export async function localPull(
  remoteDir: string,
  remoteKey: string,
  localPath: string,
  expectedHash?: string,
): Promise<void> {
  const backend = new LocalBackend(remoteDir);
  await backend.pull(remoteKey, localPath, expectedHash);
}

export function localBlobExists(remoteDir: string, remoteKey: string): boolean {
  const blobPath = join(remoteDir, remoteKey);
  return existsSync(blobPath);
}

export async function localHealthCheck(remoteDir: string): Promise<void> {
  const backend = new LocalBackend(remoteDir);
  await backend.healthCheck();
}

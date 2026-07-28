/**
 * Local filesystem backend.
 *
 * Directory-to-directory file copy for dev/testing. Same interface as
 * cloud backends. Atomic downloads via temp-file-then-rename.
 */

import { copyFile, access, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Backend } from './types.js';
import { BlobsyError, UserError } from './types.js';
import { computeHash } from './hash.js';
import { ensureDir } from './fs-utils.js';

export class LocalBackend implements Backend {
  readonly type = 'local' as const;
  private readonly remoteDir: string;

  constructor(remoteDir: string) {
    this.remoteDir = remoteDir;
  }

  /**
   * Resolve a remote key inside the backend directory, rejecting escapes.
   *
   * `remote_key` comes from `.bref` files, which arrive via git from other
   * contributors — attacker-influenceable input. A key like `../../x` must
   * never reach read, write, or delete outside the backend directory
   * (review finding BE-03).
   */
  private resolveKey(remoteKey: string): string {
    const root = resolve(this.remoteDir);
    const resolved = resolve(root, remoteKey);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new BlobsyError(
        `Invalid remote_key escapes the backend directory: ${remoteKey}`,
        'validation',
        1,
        ['The .bref file may be corrupted or malicious. Inspect it before retrying.'],
      );
    }
    return resolved;
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    const destPath = this.resolveKey(remoteKey);
    await ensureDir(dirname(destPath));

    try {
      await copyFile(localPath, destPath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;

      if (error.code === 'ENOENT') {
        throw new UserError(
          `Cannot push: source file not found: ${localPath}`,
          `Check that the file exists`,
        );
      }

      if (error.code === 'EACCES') {
        throw new UserError(
          `Permission denied writing to backend: ${this.remoteDir}`,
          `Check backend directory permissions`,
        );
      }

      throw error; // Re-throw unexpected errors
    }
  }

  async pull(remoteKey: string, localPath: string, expectedHash?: string): Promise<void> {
    const srcPath = this.resolveKey(remoteKey);

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
      try {
        await copyFile(srcPath, tmpPath);
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;

        if (error.code === 'EACCES') {
          throw new UserError(
            `Permission denied reading from backend: ${this.remoteDir}`,
            `Check backend directory permissions`,
          );
        }

        throw error; // Re-throw for outer catch
      }

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

      try {
        await rename(tmpPath, localPath);
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;

        if (error.code === 'EACCES') {
          throw new UserError(
            `Permission denied writing file: ${localPath}`,
            `Check directory permissions`,
          );
        }

        throw error; // Re-throw for outer catch
      }
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
    // Propagate resolveKey validation errors instead of reporting "blob
    // absent": push/pull/delete reject the same traversal key loudly, and
    // a status check must surface the malformed .bref, not hide it
    // (Bugbot r5).
    const blobPath = this.resolveKey(remoteKey);
    return Promise.resolve(existsSync(blobPath));
  }

  async delete(remoteKey: string): Promise<void> {
    const blobPath = this.resolveKey(remoteKey);
    if (!existsSync(blobPath)) {
      throw new BlobsyError(`Remote blob not found: ${remoteKey}`, 'not_found', 1, [
        'The blob may have already been deleted.',
      ]);
    }
    await unlink(blobPath);
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

/**
 * Standalone helper functions used by tests.
 * New code should use LocalBackend class directly.
 */

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

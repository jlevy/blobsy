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
import { realpathDeep } from './paths.js';

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
    // Strictly inside the root: an empty or "." key resolves to the store
    // root itself, and push/pull/delete on the root corrupts or exposes the
    // backend layout (Bugbot r6).
    if (!resolved.startsWith(root + sep)) {
      this.throwEscape(remoteKey);
    }
    // The lexical check alone is not enough: a symlink inside the store can
    // point outside it, and push/pull/exists/delete would follow the link
    // past the boundary. Resolve symlinks — via the deepest existing
    // ancestor for not-yet-created keys, same policy as resolveRepoPath
    // (SEC-02) — and re-check containment (Bugbot r13).
    const realRoot = realpathDeep(root);
    const effective = realpathDeep(resolved);
    if (!effective.startsWith(realRoot + sep)) {
      this.throwEscape(remoteKey);
    }
    return resolved;
  }

  private throwEscape(remoteKey: string): never {
    throw new BlobsyError(
      `Invalid remote_key escapes the backend directory: ${JSON.stringify(remoteKey)}`,
      'validation',
      1,
      ['The .bref file may be corrupted or malicious. Inspect it before retrying.'],
    );
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    const destPath = this.resolveKey(remoteKey);
    await ensureDir(dirname(destPath));

    // Copy to a temp name, then rename: a direct copyFile interrupted
    // mid-write leaves a partial blob under the final key that later reads
    // treat as the real object (review finding BE-09).
    const tmpPath = `${destPath}.blobsy-push-${randomBytes(8).toString('hex')}`;
    try {
      await copyFile(localPath, tmpPath);
      await rename(tmpPath, destPath);
    } catch (err: unknown) {
      try {
        await unlink(tmpPath);
      } catch {
        // Temp file may not exist if the copy failed early.
      }
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async exists(remoteKey: string): Promise<boolean> {
    // Propagate resolveKey validation errors (as a rejection, not a sync
    // throw) instead of reporting "blob absent": push/pull/delete reject
    // the same traversal key loudly, and a status check must surface the
    // malformed .bref, not hide it (Bugbot r5).
    const blobPath = this.resolveKey(remoteKey);
    return existsSync(blobPath);
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

/**
 * rclone backend.
 *
 * Multi-cloud transfers via the `rclone` CLI. Supports GCS, Azure, S3,
 * and 70+ other storage backends. This delegates to the user's installed
 * `rclone` binary, inheriting their remote configuration from
 * `~/.config/rclone/rclone.conf`.
 *
 * Follows the same pattern as AwsCliBackend — same Backend interface,
 * same atomic pull behavior, same error categorization.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Backend, BackendType, ResolvedBackendConfig } from './types.js';
import { BlobsyError } from './types.js';
import { categorizeCommandError } from './backend-command.js';
import { computeHash } from './hash.js';
import { ensureDir } from './fs-utils.js';
import { parseBackendUrl } from './backend-url.js';

export interface RcloneBackendConfig {
  type: BackendType;
  remote: string;
  bucket: string;
  prefix: string;
}

/** Build an RcloneBackendConfig from a resolved backend config. */
export function buildRcloneConfig(config: ResolvedBackendConfig): RcloneBackendConfig {
  const remote = config.rclone_remote;
  if (!remote) {
    throw new BlobsyError(
      `${config.type} backend requires rclone_remote to be set in .blobsy.yml.`,
      'validation',
      1,
      [
        'Install rclone: https://rclone.org/install/',
        'Configure a remote: rclone config',
        'Then add rclone_remote: <remote-name> to your backend in .blobsy.yml',
      ],
    );
  }

  const parsed = config.url ? parseBackendUrl(config.url) : undefined;
  const bucket = config.bucket ?? parsed?.bucket ?? '';
  const prefix = config.prefix ?? parsed?.prefix ?? '';

  return { type: config.type, remote, bucket, prefix };
}

export class RcloneBackend implements Backend {
  readonly type: BackendType;
  private readonly remote: string;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: RcloneBackendConfig) {
    this.type = config.type;
    this.remote = config.remote;
    this.bucket = config.bucket;
    this.prefix = config.prefix;
  }

  private fullKey(remoteKey: string): string {
    return this.prefix ? `${this.prefix}${remoteKey}` : remoteKey;
  }

  private remotePath(key: string): string {
    return `${this.remote}:${this.bucket}/${key}`;
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    if (!existsSync(localPath)) {
      throw new BlobsyError(`Local file not found: ${localPath}`, 'not_found');
    }

    const key = this.fullKey(remoteKey);
    this.exec(['copyto', resolve(localPath), this.remotePath(key)], 'push');
    return Promise.resolve();
  }

  async pull(remoteKey: string, localPath: string, expectedHash?: string): Promise<void> {
    const key = this.fullKey(remoteKey);
    const tmpSuffix = randomBytes(8).toString('hex');
    const tmpPath = `${localPath}.blobsy-rclone-${tmpSuffix}`;
    await ensureDir(dirname(localPath));

    try {
      this.exec(['copyto', this.remotePath(key), resolve(tmpPath)], 'pull');

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
        if (existsSync(tmpPath)) {
          await unlink(tmpPath);
        }
      } catch {
        // Ignore cleanup
      }
      throw err;
    }
  }

  async exists(remoteKey: string): Promise<boolean> {
    const key = this.fullKey(remoteKey);
    try {
      const output = this.exec(['lsf', this.remotePath(key)], 'exists');
      return Promise.resolve(output.trim().length > 0);
    } catch (err) {
      if (err instanceof BlobsyError && err.category === 'not_found') {
        return Promise.resolve(false);
      }
      throw err;
    }
  }

  async healthCheck(): Promise<void> {
    const remotePrefix = this.prefix
      ? `${this.remote}:${this.bucket}/${this.prefix}`
      : `${this.remote}:${this.bucket}/`;
    // `rclone lsf` supports `--max-depth`, but not `--max-count` across versions.
    this.exec(['lsf', remotePrefix, '--max-depth', '1'], 'health check');
    return Promise.resolve();
  }

  async delete(remoteKey: string): Promise<void> {
    const key = this.fullKey(remoteKey);
    this.exec(['deletefile', this.remotePath(key)], 'delete');
    return Promise.resolve();
  }

  private exec(args: string[], operation: string): string {
    try {
      const result = execFileSync('rclone', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });
      return result.toString();
    } catch (err) {
      const execError = err as {
        status?: number;
        stdout?: Buffer;
        stderr?: Buffer;
        code?: string;
      };

      if (execError.code === 'ENOENT') {
        throw new BlobsyError(
          'rclone not found. Install it from https://rclone.org/install/',
          'not_found',
        );
      }

      const exitCode = execError.status ?? 1;
      const stderr = execError.stderr?.toString().trim() ?? '';
      const stdout = execError.stdout?.toString().trim() ?? '';
      const details = [stdout, stderr].filter(Boolean).join('\n');

      // rclone lsf returns exit 3 for directory/file not found
      if (operation === 'exists' && (exitCode === 3 || stderr.includes('directory not found'))) {
        throw new BlobsyError(`Not found: rclone ${args.join(' ')}`, 'not_found');
      }

      // rclone "couldn't find remote" is a config error
      if (stderr.includes("couldn't find remote")) {
        throw new BlobsyError(
          `rclone remote "${this.remote}" not found. Run: rclone config`,
          'validation',
          exitCode,
          [
            `Check configured remotes: rclone listremotes`,
            `Create a new remote: rclone config create ${this.remote} <type>`,
          ],
        );
      }

      throw new BlobsyError(
        `rclone ${operation} failed (exit ${exitCode}): rclone ${args.join(' ')}\n${details}`,
        categorizeCommandError(stderr),
        exitCode,
      );
    }
  }
}

/** Check if the rclone binary is available in PATH. */
export function isRcloneAvailable(): boolean {
  try {
    execFileSync('rclone', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * AWS CLI backend.
 *
 * S3 transfers via the `aws` CLI. This is the default transfer path for
 * s3:// backends — it delegates to the user's installed `aws` binary,
 * inheriting their credential configuration (profiles, SSO, env vars,
 * IAM roles) without any SDK-specific setup.
 *
 * Falls back to BuiltinS3Backend (@aws-sdk/client-s3) when the aws CLI
 * is not available.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Backend } from './types.js';
import { BlobsyError } from './types.js';
import { categorizeCommandError } from './backend-command.js';
import { computeHash } from './hash.js';
import { ensureDir } from './fs-utils.js';

import type { S3BackendConfig } from './backend-s3.js';

export class AwsCliBackend implements Backend {
  readonly type = 's3' as const;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly extraArgs: string[];

  constructor(config: S3BackendConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? '';

    this.extraArgs = [];
    if (config.endpoint) {
      this.extraArgs.push('--endpoint-url', config.endpoint);
    }
    if (config.region) {
      this.extraArgs.push('--region', config.region);
    }
  }

  private fullKey(remoteKey: string): string {
    return this.prefix ? `${this.prefix}${remoteKey}` : remoteKey;
  }

  private s3Uri(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    if (!existsSync(localPath)) {
      throw new BlobsyError(`Local file not found: ${localPath}`, 'not_found');
    }

    const key = this.fullKey(remoteKey);
    this.exec(['s3', 'cp', resolve(localPath), this.s3Uri(key), ...this.extraArgs], 'push');
    return Promise.resolve();
  }

  async pull(remoteKey: string, localPath: string, expectedHash?: string): Promise<void> {
    const key = this.fullKey(remoteKey);
    const tmpSuffix = randomBytes(8).toString('hex');
    const tmpPath = `${localPath}.blobsy-aws-${tmpSuffix}`;
    await ensureDir(dirname(localPath));

    try {
      this.exec(['s3', 'cp', this.s3Uri(key), resolve(tmpPath), ...this.extraArgs], 'pull');

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
      this.exec(
        ['s3api', 'head-object', '--bucket', this.bucket, '--key', key, ...this.extraArgs],
        'exists',
      );
      return Promise.resolve(true);
    } catch (err) {
      if (err instanceof BlobsyError && err.category === 'not_found') {
        return Promise.resolve(false);
      }
      throw err;
    }
  }

  async healthCheck(): Promise<void> {
    this.exec(['s3api', 'head-bucket', '--bucket', this.bucket, ...this.extraArgs], 'health check');
    return Promise.resolve();
  }

  async delete(remoteKey: string): Promise<void> {
    const key = this.fullKey(remoteKey);
    this.exec(['s3', 'rm', this.s3Uri(key), ...this.extraArgs], 'delete');
    return Promise.resolve();
  }

  private exec(args: string[], operation: string): void {
    try {
      execFileSync('aws', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });
    } catch (err) {
      const execError = err as {
        status?: number;
        stdout?: Buffer;
        stderr?: Buffer;
        code?: string;
      };

      if (execError.code === 'ENOENT') {
        throw new BlobsyError(
          'aws CLI not found. Install it or set sync.tools: [aws-sdk] in .blobsy.yml.',
          'not_found',
        );
      }

      const exitCode = execError.status ?? 1;
      const stderr = execError.stderr?.toString().trim() ?? '';
      const stdout = execError.stdout?.toString().trim() ?? '';
      const details = [stdout, stderr].filter(Boolean).join('\n');

      // aws s3api head-object returns 254 for not found
      if (operation === 'exists' && (exitCode === 254 || stderr.includes('Not Found'))) {
        throw new BlobsyError(`Not found: ${args.join(' ')}`, 'not_found');
      }

      throw new BlobsyError(
        `aws ${operation} failed (exit ${exitCode}): aws ${args.join(' ')}\n${details}`,
        categorizeCommandError(stderr),
        exitCode,
      );
    }
  }
}

/** Check if the aws CLI binary is available in PATH. */
export function isAwsCliAvailable(): boolean {
  try {
    execFileSync('aws', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

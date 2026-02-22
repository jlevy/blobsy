/**
 * Built-in S3 backend (AWS SDK).
 *
 * Fallback S3 backend using @aws-sdk/client-s3 directly. Used when the
 * aws CLI is not installed or when explicitly selected via
 * sync.tools: [aws-sdk] in .blobsy.yml.
 */

import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

import type { Backend, ErrorCategory } from './types.js';
import { BlobsyError } from './types.js';
import { computeHash } from './hash.js';
import { ensureDir } from './fs-utils.js';

export interface S3BackendConfig {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
}

export class BuiltinS3Backend implements Backend {
  readonly type = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3BackendConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? '';

    const clientConfig: S3ClientConfig = {};
    if (config.region) {
      clientConfig.region = config.region;
    }
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
      clientConfig.forcePathStyle = true;
    }
    this.client = new S3Client(clientConfig);
  }

  private fullKey(remoteKey: string): string {
    return this.prefix ? `${this.prefix}${remoteKey}` : remoteKey;
  }

  async push(localPath: string, remoteKey: string): Promise<void> {
    if (!existsSync(localPath)) {
      throw new BlobsyError(`Local file not found: ${localPath}`, 'not_found');
    }

    const key = this.fullKey(remoteKey);
    const body = await readFile(localPath);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
        }),
      );
    } catch (err) {
      throw this.wrapError(err, `push to s3://${this.bucket}/${key}`);
    }
  }

  async pull(remoteKey: string, localPath: string, expectedHash?: string): Promise<void> {
    const key = this.fullKey(remoteKey);
    const tmpSuffix = randomBytes(8).toString('hex');
    const tmpPath = `${localPath}.blobsy-s3-${tmpSuffix}`;
    await ensureDir(dirname(localPath));

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      if (!response.Body) {
        throw new BlobsyError(`Empty response from S3 for key: ${key}`, 'not_found');
      }

      // Stream to temp file
      const chunks: Buffer[] = [];
      for await (const chunk of response.Body as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      await writeFile(tmpPath, Buffer.concat(chunks));

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
      if (err instanceof BlobsyError) {
        throw err;
      }
      throw this.wrapError(err, `pull from s3://${this.bucket}/${key}`);
    }
  }

  async exists(remoteKey: string): Promise<boolean> {
    const key = this.fullKey(remoteKey);
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') {
        return false;
      }
      throw this.wrapError(err, `check existence of s3://${this.bucket}/${key}`);
    }
  }

  async healthCheck(): Promise<void> {
    const healthKey = this.fullKey(`.blobsy-health-check-${randomBytes(4).toString('hex')}`);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: healthKey,
          Body: 'health-check',
        }),
      );
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: healthKey,
        }),
      );
    } catch (err) {
      throw this.wrapError(err, `health check on s3://${this.bucket}`);
    }
  }

  async delete(remoteKey: string): Promise<void> {
    const key = this.fullKey(remoteKey);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (err) {
      throw this.wrapError(err, `delete s3://${this.bucket}/${key}`);
    }
  }

  private wrapError(err: unknown, operation: string): BlobsyError {
    const name = (err as { name?: string }).name ?? '';
    const message = err instanceof Error ? err.message : String(err);
    const category = categorizeS3Error(name, message);
    const suggestions = suggestionsForCategory(category);
    return new BlobsyError(`S3 ${operation}: ${message}`, category, 1, suggestions);
  }
}

function categorizeS3Error(errorName: string, message: string): ErrorCategory {
  const lower = `${errorName} ${message}`.toLowerCase();

  if (
    lower.includes('accessdenied') ||
    lower.includes('invalidaccesskeyid') ||
    lower.includes('signaturedo') ||
    lower.includes('403') ||
    lower.includes('forbidden')
  ) {
    return 'authentication';
  }
  if (
    lower.includes('nosuchbucket') ||
    lower.includes('nosuchkey') ||
    lower.includes('notfound') ||
    lower.includes('404')
  ) {
    return 'not_found';
  }
  if (
    lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('networkingerror') ||
    lower.includes('network')
  ) {
    return 'network';
  }
  if (lower.includes('quotaexceeded') || lower.includes('slowdown')) {
    return 'quota';
  }
  return 'unknown';
}

function suggestionsForCategory(category: ErrorCategory): string[] | undefined {
  switch (category) {
    case 'authentication':
      return [
        'Check your AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).',
        'Verify the bucket policy allows your IAM user/role.',
      ];
    case 'not_found':
      return [
        'Check the bucket name and region in .blobsy.yml.',
        'Verify the bucket exists and you have access.',
      ];
    case 'network':
      return [
        'Check your network connection.',
        'If using a custom endpoint, verify it is reachable.',
      ];
    default:
      return undefined;
  }
}

/**
 * Built-in S3 backend (AWS SDK).
 *
 * Fallback S3 backend using @aws-sdk/client-s3 directly. Used when the
 * aws CLI is not installed or when explicitly selected via
 * sync.tools: [aws-sdk] in .blobsy.yml.
 */

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  S3Client,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import type { Backend, ErrorCategory } from './types.js';
import { BlobsyError, UserError } from './types.js';
import { computeHash } from './hash.js';
import { ensureDir } from './fs-utils.js';

/** Multipart part size. 8 MiB parts allow objects up to ~78 GiB (10k parts). */
const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;

/** Concurrent part uploads per file. */
const UPLOAD_PART_CONCURRENCY = 4;

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

    // Streaming multipart upload (review finding BE-04): buffering the whole
    // file OOMs multi-GB payloads, and even a streamed single PutObject caps
    // at 5 GB. lib-storage's Upload streams parts and aborts the multipart
    // upload on error (leavePartsOnError: false) so failed transfers don't
    // strand billable parts.
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(localPath),
      },
      partSize: UPLOAD_PART_SIZE_BYTES,
      queueSize: UPLOAD_PART_CONCURRENCY,
      leavePartsOnError: false,
    });

    try {
      await upload.done();
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EACCES') {
        throw new UserError(
          `Permission denied reading file: ${localPath}`,
          `Check file permissions`,
        );
      }
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

      // Stream to temp file — never accumulate the object in memory
      // (review finding BE-04: chunk accumulation held ~2× file size).
      await pipeline(response.Body as Readable, createWriteStream(tmpPath));

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
        if (existsSync(tmpPath)) {
          await unlink(tmpPath);
        }
      } catch {
        // Ignore cleanup
      }
      if (err instanceof BlobsyError || err instanceof UserError) {
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
      // Not-found comes in several shapes across SDK versions and S3
      // implementations: error name, NoSuchBucket, or a bare 404 status
      // (review finding BE-09).
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        e.name === 'NotFound' ||
        e.name === 'NoSuchKey' ||
        e.name === 'NoSuchBucket' ||
        e.$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw this.wrapError(err, `check existence of s3://${this.bucket}/${key}`);
    }
  }

  async healthCheck(): Promise<void> {
    // HeadBucket only: a put+delete probe fails for read-only credentials
    // (common for pull-only CI) and a failed delete strands probe objects
    // (review finding BE-07).
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
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
    case 'permission':
    case 'quota':
    case 'storage_full':
    case 'validation':
    case 'conflict':
    case 'unknown':
      return undefined;
    default: {
      const _exhaustive: never = category;
      return undefined;
    }
  }
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BuiltinS3Backend } from '../src/backend-s3.js';
import { BlobsyError } from '../src/types.js';

const mockSend = vi.fn();

// lib-storage's Upload drives multipart via these commands on the same
// client.send, so the mock must know all of them. (The factory is hoisted,
// so the shared base class must live inside it.)
vi.mock('@aws-sdk/client-s3', () => {
  class MockCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    S3Client: class {
      send = mockSend;
      // lib-storage's Upload reads these from the client config.
      config = {
        requestHandler: {},
        requestChecksumCalculation: () => Promise.resolve('WHEN_REQUIRED'),
        endpointProvider: () => ({ url: new URL('https://s3.example.test') }),
      };
    },
    PutObjectCommand: class PutObjectCommand extends MockCommand {},
    GetObjectCommand: class GetObjectCommand extends MockCommand {},
    HeadBucketCommand: class HeadBucketCommand extends MockCommand {},
    HeadObjectCommand: class HeadObjectCommand extends MockCommand {},
    DeleteObjectCommand: class DeleteObjectCommand extends MockCommand {},
    CreateMultipartUploadCommand: class CreateMultipartUploadCommand extends MockCommand {},
    UploadPartCommand: class UploadPartCommand extends MockCommand {},
    CompleteMultipartUploadCommand: class CompleteMultipartUploadCommand extends MockCommand {},
    AbortMultipartUploadCommand: class AbortMultipartUploadCommand extends MockCommand {},
    ListPartsCommand: class ListPartsCommand extends MockCommand {},
    PutObjectTaggingCommand: class PutObjectTaggingCommand extends MockCommand {},
  };
});

describe('BuiltinS3Backend', () => {
  let backend: BuiltinS3Backend;

  beforeEach(() => {
    mockSend.mockReset();
    backend = new BuiltinS3Backend({
      bucket: 'test-bucket',
      prefix: 'blobs/',
      region: 'us-east-1',
    });
  });

  it('constructs with correct config', () => {
    expect(backend.type).toBe('s3');
  });

  it('exists returns true for existing key', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await backend.exists('some-key');
    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it('exists returns false for NotFound', async () => {
    const notFoundError = new Error('Not Found');
    (notFoundError as { name: string }).name = 'NotFound';
    mockSend.mockRejectedValueOnce(notFoundError);
    const result = await backend.exists('missing-key');
    expect(result).toBe(false);
  });

  it('exists throws BlobsyError for other S3 errors', async () => {
    const accessDenied = new Error('Access Denied');
    (accessDenied as { name: string }).name = 'AccessDenied';
    mockSend.mockRejectedValueOnce(accessDenied);
    await expect(backend.exists('some-key')).rejects.toThrow(BlobsyError);
  });

  it('healthCheck sends a single HeadBucket probe, no write (BE-07)', async () => {
    mockSend.mockResolvedValue({});
    await backend.healthCheck();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockSend.mock.calls[0]![0] as { constructor: { name: string } };
    expect(call.constructor.name).toBe('HeadBucketCommand');
  });

  it('healthCheck wraps S3 errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('NoSuchBucket'));
    await expect(backend.healthCheck()).rejects.toThrow(BlobsyError);
  });

  // These must fail if the code under test stops throwing — a bare
  // try/catch with assertions only inside catch passes with zero assertions
  // executed (review finding TEST-03).
  it('wraps errors with authentication category', async () => {
    const err = new Error('Access Denied');
    (err as { name: string }).name = 'AccessDenied';
    mockSend.mockRejectedValueOnce(err);

    const thrown = await backend.exists('key').then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(BlobsyError);
    expect((thrown as BlobsyError).category).toBe('authentication');
    expect((thrown as BlobsyError).suggestions).toBeDefined();
  });

  it('wraps errors with not_found category', async () => {
    const err = new Error('The specified bucket does not exist');
    (err as { name: string }).name = 'NoSuchBucket';
    mockSend.mockRejectedValueOnce(err);

    const thrown = await backend.healthCheck().then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(BlobsyError);
    expect((thrown as BlobsyError).category).toBe('not_found');
  });

  it('prefix is prepended to keys', async () => {
    mockSend.mockResolvedValueOnce({});
    await backend.exists('remote-key/file.bin');
    const call = mockSend.mock.calls[0]![0] as { input: { Key: string } };
    expect(call.input.Key).toBe('blobs/remote-key/file.bin');
  });

  describe('streaming transfers (BE-04)', () => {
    let tmpDir: string;

    const sentCommandNames = () =>
      mockSend.mock.calls.map((call) => (call[0] as object).constructor.name);

    /** Route mocked sends by command type, as lib-storage's Upload expects. */
    const routeMultipartSends = () => {
      mockSend.mockImplementation((cmd: object) => {
        switch (cmd.constructor.name) {
          case 'CreateMultipartUploadCommand':
            return Promise.resolve({ UploadId: 'upload-1' });
          case 'UploadPartCommand':
            return Promise.resolve({ ETag: `etag-${mockSend.mock.calls.length}` });
          default:
            return Promise.resolve({});
        }
      });
    };

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'blobsy-s3-test-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('push uploads a small file as a single streamed PutObject', async () => {
      routeMultipartSends();
      const filePath = join(tmpDir, 'small.bin');
      await writeFile(filePath, 'small content');

      await backend.push(filePath, 'small.bin');

      expect(sentCommandNames()).toContain('PutObjectCommand');
      expect(sentCommandNames()).not.toContain('CreateMultipartUploadCommand');
    });

    it('push switches to multipart above the part size (no 5 GB single-PUT cap)', async () => {
      routeMultipartSends();
      const filePath = join(tmpDir, 'big.bin');
      // 12 MiB with 8 MiB parts -> 2 parts.
      await writeFile(filePath, Buffer.alloc(12 * 1024 * 1024, 7));

      await backend.push(filePath, 'big.bin');

      const names = sentCommandNames();
      expect(names).toContain('CreateMultipartUploadCommand');
      expect(names.filter((n) => n === 'UploadPartCommand')).toHaveLength(2);
      expect(names).toContain('CompleteMultipartUploadCommand');
    });

    it('push aborts the multipart upload when a part fails', async () => {
      mockSend.mockImplementation((cmd: object) => {
        switch (cmd.constructor.name) {
          case 'CreateMultipartUploadCommand':
            return Promise.resolve({ UploadId: 'upload-1' });
          case 'UploadPartCommand':
            return Promise.reject(new Error('network blip'));
          default:
            return Promise.resolve({});
        }
      });
      const filePath = join(tmpDir, 'big.bin');
      await writeFile(filePath, Buffer.alloc(12 * 1024 * 1024, 7));

      await expect(backend.push(filePath, 'big.bin')).rejects.toThrow(BlobsyError);
      expect(sentCommandNames()).toContain('AbortMultipartUploadCommand');
    });

    it('pull streams the body to disk and verifies the hash', async () => {
      const content = 'streamed pull content';
      mockSend.mockResolvedValueOnce({ Body: Readable.from([Buffer.from(content)]) });
      const destPath = join(tmpDir, 'pulled.bin');

      await backend.pull('some-key', destPath);

      expect(await readFile(destPath, 'utf-8')).toBe(content);
    });

    it('pull cleans up the temp file and rejects on hash mismatch', async () => {
      mockSend.mockResolvedValueOnce({ Body: Readable.from([Buffer.from('corrupted')]) });
      const destPath = join(tmpDir, 'pulled.bin');

      await expect(backend.pull('some-key', destPath, `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
        /Hash mismatch/,
      );

      const { readdir } = await import('node:fs/promises');
      expect(await readdir(tmpDir)).toEqual([]);
    });
  });

  it('works without prefix', async () => {
    const noPrefix = new BuiltinS3Backend({ bucket: 'test-bucket' });
    mockSend.mockResolvedValueOnce({});
    await noPrefix.exists('remote-key/file.bin');
    const call = mockSend.mock.calls[0]![0] as { input: { Key: string } };
    expect(call.input.Key).toBe('remote-key/file.bin');
  });
});

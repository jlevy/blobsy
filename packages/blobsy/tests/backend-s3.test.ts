import { describe, it, expect, vi, beforeEach } from 'vitest';

import { S3Backend } from '../src/backend-s3.js';
import { BlobsyError } from '../src/types.js';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mockSend;
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  HeadObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  DeleteObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

describe('S3Backend', () => {
  let backend: S3Backend;

  beforeEach(() => {
    mockSend.mockReset();
    backend = new S3Backend({
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

  it('healthCheck writes and deletes a temp key', async () => {
    mockSend.mockResolvedValue({});
    await backend.healthCheck();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('healthCheck wraps S3 errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('NoSuchBucket'));
    await expect(backend.healthCheck()).rejects.toThrow(BlobsyError);
  });

  it('wraps errors with authentication category', async () => {
    const err = new Error('Access Denied');
    (err as { name: string }).name = 'AccessDenied';
    mockSend.mockRejectedValueOnce(err);

    try {
      await backend.exists('key');
    } catch (e) {
      expect(e).toBeInstanceOf(BlobsyError);
      expect((e as BlobsyError).category).toBe('authentication');
      expect((e as BlobsyError).suggestions).toBeDefined();
    }
  });

  it('wraps errors with not_found category', async () => {
    const err = new Error('The specified bucket does not exist');
    (err as { name: string }).name = 'NoSuchBucket';
    mockSend.mockRejectedValueOnce(err);

    try {
      await backend.healthCheck();
    } catch (e) {
      expect(e).toBeInstanceOf(BlobsyError);
      expect((e as BlobsyError).category).toBe('not_found');
    }
  });

  it('prefix is prepended to keys', async () => {
    mockSend.mockResolvedValueOnce({});
    await backend.exists('remote-key/file.bin');
    const call = mockSend.mock.calls[0]![0] as { input: { Key: string } };
    expect(call.input.Key).toBe('blobs/remote-key/file.bin');
  });

  it('works without prefix', async () => {
    const noPrefix = new S3Backend({ bucket: 'test-bucket' });
    mockSend.mockResolvedValueOnce({});
    await noPrefix.exists('remote-key/file.bin');
    const call = mockSend.mock.calls[0]![0] as { input: { Key: string } };
    expect(call.input.Key).toBe('remote-key/file.bin');
  });
});

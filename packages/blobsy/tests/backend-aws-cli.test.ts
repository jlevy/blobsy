/**
 * AwsCliBackend tests (review finding TEST-03: this primary S3 transfer path
 * had no test file at all). The aws binary is mocked at the child_process
 * layer so argument construction, error categorization, and temp-file
 * hygiene are all pinned without credentials.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AwsCliBackend } from '../src/backend-aws-cli.js';
import { BlobsyError } from '../src/types.js';

const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args) as unknown,
}));

function execError(overrides: { status?: number; stderr?: string; code?: string }): Error {
  const err = new Error('command failed') as Error & {
    status?: number;
    stderr?: Buffer;
    stdout?: Buffer;
    code?: string;
  };
  if (overrides.status !== undefined) {
    err.status = overrides.status;
  }
  if (overrides.stderr !== undefined) {
    err.stderr = Buffer.from(overrides.stderr);
  }
  if (overrides.code !== undefined) {
    err.code = overrides.code;
  }
  return err;
}

describe('AwsCliBackend', () => {
  let backend: AwsCliBackend;
  let tmpDir: string;

  const awsArgs = (call: number): string[] => mockExecFileSync.mock.calls[call]![1] as string[];

  beforeEach(async () => {
    mockExecFileSync.mockReset();
    backend = new AwsCliBackend({
      bucket: 'test-bucket',
      prefix: 'blobs/',
      region: 'us-east-1',
      endpoint: 'https://s3.example.test',
    });
    tmpDir = await mkdtemp(join(tmpdir(), 'blobsy-awscli-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('push invokes aws s3 cp with prefix, endpoint, and region', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    const filePath = join(tmpDir, 'file.bin');
    await writeFile(filePath, 'content');

    await backend.push(filePath, 'some/key.bin');

    expect(awsArgs(0)).toEqual([
      's3',
      'cp',
      resolve(filePath),
      's3://test-bucket/blobs/some/key.bin',
      '--endpoint-url',
      'https://s3.example.test',
      '--region',
      'us-east-1',
    ]);
  });

  it('push of a missing local file fails without invoking aws', async () => {
    await expect(backend.push(join(tmpDir, 'nope.bin'), 'k')).rejects.toThrow(BlobsyError);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('missing aws binary maps to a clear not_found error', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw execError({ code: 'ENOENT' });
    });
    const filePath = join(tmpDir, 'file.bin');
    await writeFile(filePath, 'content');

    const thrown = await backend.push(filePath, 'k').then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(BlobsyError);
    expect((thrown as BlobsyError).message).toMatch(/aws CLI not found/);
  });

  it('pull downloads via temp file and renames into place', async () => {
    const destPath = join(tmpDir, 'pulled.bin');
    // aws s3 cp <uri> <tmpPath> — simulate the CLI writing the temp file.
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const argv = args as string[];
      writeFileSync(argv[3]!, 'downloaded');
      return Buffer.from('');
    });

    await backend.pull('some/key.bin', destPath);

    expect(existsSync(destPath)).toBe(true);
    expect(awsArgs(0).slice(0, 3)).toEqual(['s3', 'cp', 's3://test-bucket/blobs/some/key.bin']);
    // No leftover temp files.
    expect((await readdir(tmpDir)).filter((f) => f.includes('.blobsy-aws-'))).toEqual([]);
  });

  it('pull cleans up its temp file when the transfer fails', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw execError({ status: 1, stderr: 'fatal error: connection reset' });
    });

    await expect(backend.pull('k', join(tmpDir, 'pulled.bin'))).rejects.toThrow(BlobsyError);
    expect((await readdir(tmpDir)).filter((f) => f.includes('.blobsy-aws-'))).toEqual([]);
  });

  it('exists returns false on head-object 254 (not found)', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw execError({ status: 254, stderr: 'Not Found' });
    });
    expect(await backend.exists('missing-key')).toBe(false);
  });

  it('exists surfaces non-not_found failures', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw execError({ status: 255, stderr: 'AccessDenied: forbidden' });
    });
    await expect(backend.exists('some-key')).rejects.toThrow(BlobsyError);
  });

  it('categorizes credential failures as authentication errors', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw execError({ status: 1, stderr: 'An error occurred (AccessDenied) 403' });
    });
    const filePath = join(tmpDir, 'file.bin');
    await writeFile(filePath, 'content');

    const thrown = await backend.push(filePath, 'k').then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(BlobsyError);
    expect((thrown as BlobsyError).category).toBe('authentication');
  });

  it('healthCheck uses head-bucket (no write probe)', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));
    await backend.healthCheck();
    expect(awsArgs(0).slice(0, 2)).toEqual(['s3api', 'head-bucket']);
  });
});

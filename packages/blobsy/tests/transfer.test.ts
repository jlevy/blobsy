import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  resolveBackend,
  createBackend,
  pushFile,
  pullFile,
  blobExists,
  runHealthCheck,
} from '../src/transfer.js';
import { AwsCliBackend } from '../src/backend-aws-cli.js';
import { BuiltinS3Backend } from '../src/backend-s3.js';
import { RcloneBackend } from '../src/backend-rclone.js';
import { computeHash } from '../src/hash.js';
import type { BlobsyConfig, Bref, ResolvedBackendConfig } from '../src/types.js';
import { BREF_FORMAT, BlobsyError } from '../src/types.js';

describe('resolveBackend', () => {
  it('resolves the default backend', () => {
    const config: BlobsyConfig = {
      backends: {
        default: { url: 'local:./remote' },
      },
    };
    const backend = resolveBackend(config);
    expect(backend.type).toBe('local');
  });

  it('resolves a named backend', () => {
    const config: BlobsyConfig = {
      backend: 'staging',
      backends: {
        staging: { url: 's3://my-bucket/prefix/' },
      },
    };
    const backend = resolveBackend(config);
    expect(backend.type).toBe('s3');
  });

  it('throws when no backends configured', () => {
    expect(() => resolveBackend({} as BlobsyConfig)).toThrow('No backends configured');
  });

  it('throws when named backend not found', () => {
    const config: BlobsyConfig = {
      backend: 'missing',
      backends: {
        default: { url: 'local:./remote' },
      },
    };
    expect(() => resolveBackend(config)).toThrow('not found');
  });

  it('infers command type from push_command', () => {
    const config: BlobsyConfig = {
      backends: {
        default: { push_command: 'echo push' },
      },
    };
    const backend = resolveBackend(config);
    expect(backend.type).toBe('command');
  });
});

describe('push/pull integration with local backend', () => {
  let tmpDir: string;
  let repoRoot: string;
  let remoteDir: string;
  let config: BlobsyConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'blobsy-transfer-test-'));
    repoRoot = join(tmpDir, 'repo');
    remoteDir = join(tmpDir, 'remote');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(remoteDir, { recursive: true });
    config = {
      backends: {
        default: { url: `local:${remoteDir}` },
      },
    };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pushFile uploads and returns refUpdates', async () => {
    const filePath = join(repoRoot, 'data.bin');
    await writeFile(filePath, 'push test content');
    const hash = await computeHash(filePath);

    const ref: Bref = { format: BREF_FORMAT, hash, size: 17 };
    const result = await pushFile(filePath, 'data.bin', ref, config, repoRoot);

    expect(result.success).toBe(true);
    expect(result.action).toBe('push');
    expect(result.refUpdates).toBeDefined();
    expect(result.refUpdates!.remote_key.length).toBeGreaterThan(0);
  });

  it('pullFile downloads from remote', async () => {
    const filePath = join(repoRoot, 'data.bin');
    await writeFile(filePath, 'pull test content');
    const hash = await computeHash(filePath);

    const ref: Bref = { format: BREF_FORMAT, hash, size: 17 };
    const pushResult = await pushFile(filePath, 'data.bin', ref, config, repoRoot);
    expect(pushResult.success).toBe(true);
    const updatedRef = { ...ref, ...pushResult.refUpdates };

    const pullPath = join(repoRoot, 'pulled.bin');
    const pullResult = await pullFile(updatedRef, pullPath, config, repoRoot);
    expect(pullResult.success).toBe(true);

    const content = await readFile(pullPath, 'utf-8');
    expect(content).toBe('pull test content');
  });

  it('blobExists returns true after push', async () => {
    const filePath = join(repoRoot, 'data.bin');
    await writeFile(filePath, 'exists test');
    const hash = await computeHash(filePath);

    const ref: Bref = { format: BREF_FORMAT, hash, size: 11 };
    const result = await pushFile(filePath, 'data.bin', ref, config, repoRoot);
    expect(result.success).toBe(true);
    expect(result.refUpdates?.remote_key).toBeDefined();

    await expect(blobExists(result.refUpdates!.remote_key, config, repoRoot)).resolves.toBe(true);
  });

  it('blobExists returns false for missing key', async () => {
    await expect(blobExists('nonexistent-key/file.bin', config, repoRoot)).resolves.toBe(false);
  });

  it('runHealthCheck succeeds for valid local backend', async () => {
    await expect(runHealthCheck(config, repoRoot)).resolves.toBeUndefined();
  });
});

describe('createBackend tool selection and failure modes', () => {
  const s3Config: ResolvedBackendConfig = {
    type: 's3',
    url: 's3://my-bucket/prefix/',
  };

  const s3WithRcloneConfig: ResolvedBackendConfig = {
    type: 's3',
    url: 's3://my-bucket/prefix/',
    rclone_remote: 'my-s3-remote',
  };

  const gcsConfig: ResolvedBackendConfig = {
    type: 'gcs',
    url: 'gs://my-bucket/prefix/',
  };

  const gcsWithRemoteConfig: ResolvedBackendConfig = {
    type: 'gcs',
    url: 'gs://my-bucket/prefix/',
    rclone_remote: 'my-gcs-remote',
  };

  const azureConfig: ResolvedBackendConfig = {
    type: 'azure',
    url: 'azure://my-container/prefix/',
  };

  it('uses aws-cli backend for s3 when aws-cli is available', () => {
    const backend = createBackend(s3Config, '/tmp', undefined, { awsCli: true, rclone: false });
    expect(backend).toBeInstanceOf(AwsCliBackend);
  });

  it('falls back to rclone backend for s3 when aws-cli is unavailable', () => {
    const backend = createBackend(s3WithRcloneConfig, '/tmp', undefined, {
      awsCli: false,
      rclone: true,
    });
    expect(backend).toBeInstanceOf(RcloneBackend);
  });

  it('falls back to built-in s3 backend when no external tools are available', () => {
    const backend = createBackend(s3Config, '/tmp', undefined, { awsCli: false, rclone: false });
    expect(backend).toBeInstanceOf(BuiltinS3Backend);
  });

  it('uses built-in s3 backend when rclone is available but rclone_remote is missing', () => {
    const backend = createBackend(s3Config, '/tmp', undefined, { awsCli: false, rclone: true });
    expect(backend).toBeInstanceOf(BuiltinS3Backend);
  });

  it('throws not_found for gcs when rclone is not installed', () => {
    expect(() =>
      createBackend(gcsConfig, '/tmp', undefined, { awsCli: false, rclone: false }),
    ).toThrow(BlobsyError);
    try {
      createBackend(gcsConfig, '/tmp', undefined, { awsCli: false, rclone: false });
    } catch (err) {
      expect((err as BlobsyError).category).toBe('not_found');
      expect((err as BlobsyError).message).toContain('not installed');
    }
  });

  it('throws validation for gcs when rclone_remote is missing', () => {
    expect(() =>
      createBackend(gcsConfig, '/tmp', undefined, { awsCli: false, rclone: true }),
    ).toThrow(BlobsyError);
    try {
      createBackend(gcsConfig, '/tmp', undefined, { awsCli: false, rclone: true });
    } catch (err) {
      expect((err as BlobsyError).category).toBe('validation');
      expect((err as BlobsyError).message).toContain('rclone_remote');
    }
  });

  it('creates rclone backend for gcs when rclone is available and configured', () => {
    const backend = createBackend(gcsWithRemoteConfig, '/tmp', undefined, {
      awsCli: false,
      rclone: true,
    });
    expect(backend).toBeInstanceOf(RcloneBackend);
  });

  it('throws validation for azure when rclone_remote is missing', () => {
    expect(() =>
      createBackend(azureConfig, '/tmp', undefined, { awsCli: false, rclone: true }),
    ).toThrow(BlobsyError);
    try {
      createBackend(azureConfig, '/tmp', undefined, { awsCli: false, rclone: true });
    } catch (err) {
      expect((err as BlobsyError).category).toBe('validation');
      expect((err as BlobsyError).message).toContain('rclone_remote');
    }
  });

  it('resolves gcs URL type correctly', () => {
    const config: BlobsyConfig = {
      backends: {
        default: { url: 'gs://my-bucket/prefix/' },
      },
    };
    const resolved = resolveBackend(config);
    expect(resolved.type).toBe('gcs');
  });

  it('resolves azure URL type correctly', () => {
    const config: BlobsyConfig = {
      backends: {
        default: { url: 'azure://my-container/prefix/' },
      },
    };
    const resolved = resolveBackend(config);
    expect(resolved.type).toBe('azure');
  });
});

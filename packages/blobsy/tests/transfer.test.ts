import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { resolveBackend, pushFile, pullFile, blobExists, runHealthCheck } from '../src/transfer.js';
import { computeHash } from '../src/hash.js';
import type { BlobsyConfig, YRef } from '../src/types.js';
import { YREF_FORMAT } from '../src/types.js';

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

    const ref: YRef = { format: YREF_FORMAT, hash, size: 17 };
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

    const ref: YRef = { format: YREF_FORMAT, hash, size: 17 };
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

    const ref: YRef = { format: YREF_FORMAT, hash, size: 11 };
    const result = await pushFile(filePath, 'data.bin', ref, config, repoRoot);
    const updatedRef = { ...ref, ...result.refUpdates };

    await expect(blobExists(updatedRef.remote_key!, config, repoRoot)).resolves.toBe(true);
  });

  it('blobExists returns false for missing key', async () => {
    await expect(blobExists('nonexistent-key/file.bin', config, repoRoot)).resolves.toBe(false);
  });

  it('runHealthCheck succeeds for valid local backend', async () => {
    await expect(runHealthCheck(config, repoRoot)).resolves.toBeUndefined();
  });
});

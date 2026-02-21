/**
 * E2E tests for S3 backend using MinIO.
 *
 * Requires Docker: starts a MinIO container, creates a test bucket,
 * runs push/pull/exists/health through the real S3Backend.
 *
 * Skip with: SKIP_E2E=1 or when Docker is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S3Backend } from '../../src/backend-s3.js';
import { computeHash } from '../../src/hash.js';

const MINIO_CONTAINER = 'blobsy-test-minio';
const MINIO_PORT = 19000;
const MINIO_ACCESS_KEY = 'minioadmin';
const MINIO_SECRET_KEY = 'minioadmin';
const MINIO_BUCKET = 'blobsy-test';

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function startMinio(): void {
  try {
    execSync(`docker rm -f ${MINIO_CONTAINER}`, { stdio: 'pipe' });
  } catch {
    // Container didn't exist
  }
  execSync(
    `docker run -d --name ${MINIO_CONTAINER} -p ${MINIO_PORT}:9000 ` +
      `-e MINIO_ROOT_USER=${MINIO_ACCESS_KEY} -e MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY} ` +
      `minio/minio server /data`,
    { stdio: 'pipe' },
  );
  // Wait for MinIO to be ready
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`curl -sf http://localhost:${MINIO_PORT}/minio/health/live`, { stdio: 'pipe' });
      return;
    } catch {
      execSync('sleep 1', { stdio: 'pipe' });
    }
  }
  throw new Error('MinIO failed to start within 30s');
}

function createBucket(): void {
  execSync(
    `docker exec ${MINIO_CONTAINER} mc alias set local http://localhost:9000 ${MINIO_ACCESS_KEY} ${MINIO_SECRET_KEY} && ` +
      `docker exec ${MINIO_CONTAINER} mc mb local/${MINIO_BUCKET}`,
    { stdio: 'pipe', shell: '/bin/sh' },
  );
}

function stopMinio(): void {
  try {
    execSync(`docker rm -f ${MINIO_CONTAINER}`, { stdio: 'pipe' });
  } catch {
    // Ignore
  }
}

const skipE2e = process.env.SKIP_E2E === '1' || !dockerAvailable();

describe.skipIf(skipE2e)('S3Backend with MinIO (e2e)', () => {
  let backend: S3Backend;
  let tempDir: string;

  beforeAll(() => {
    startMinio();
    createBucket();

    process.env.AWS_ACCESS_KEY_ID = MINIO_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = MINIO_SECRET_KEY;
    process.env.AWS_REGION = 'us-east-1';

    backend = new S3Backend({
      bucket: MINIO_BUCKET,
      prefix: 'test/',
      endpoint: `http://localhost:${MINIO_PORT}`,
    });

    tempDir = mkdtempSync(join(tmpdir(), 'blobsy-e2e-'));
  }, 60000);

  afterAll(() => {
    stopMinio();
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('health check passes', async () => {
    await backend.healthCheck();
  });

  it('push + exists', async () => {
    const filePath = join(tempDir, 'test-file.bin');
    writeFileSync(filePath, 'hello from blobsy e2e');

    await backend.push(filePath, 'e2e/test-file.bin');
    const exists = await backend.exists('e2e/test-file.bin');
    expect(exists).toBe(true);
  });

  it('pull + hash verification', async () => {
    const srcPath = join(tempDir, 'push-for-pull.bin');
    writeFileSync(srcPath, 'content for pull test');

    const hash = await computeHash(srcPath);
    await backend.push(srcPath, 'e2e/pull-test.bin');

    const destPath = join(tempDir, 'pulled.bin');
    await backend.pull('e2e/pull-test.bin', destPath, hash);

    expect(readFileSync(destPath, 'utf-8')).toBe('content for pull test');
  });

  it('exists returns false for missing key', async () => {
    const exists = await backend.exists('e2e/nonexistent.bin');
    expect(exists).toBe(false);
  });

  it('pull with wrong hash fails', async () => {
    const srcPath = join(tempDir, 'push-for-bad-hash.bin');
    writeFileSync(srcPath, 'content for hash check');

    await backend.push(srcPath, 'e2e/hash-check.bin');

    const destPath = join(tempDir, 'bad-hash-pull.bin');
    await expect(
      backend.pull(
        'e2e/hash-check.bin',
        destPath,
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      ),
    ).rejects.toThrow('Hash mismatch');
  });

  it('delete removes object', async () => {
    const filePath = join(tempDir, 'to-delete.bin');
    writeFileSync(filePath, 'delete me');

    await backend.push(filePath, 'e2e/to-delete.bin');
    expect(await backend.exists('e2e/to-delete.bin')).toBe(true);

    await backend.delete('e2e/to-delete.bin');
    expect(await backend.exists('e2e/to-delete.bin')).toBe(false);
  });
});

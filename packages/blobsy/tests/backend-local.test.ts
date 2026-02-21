import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { localPush, localPull, localBlobExists, localHealthCheck } from '../src/backend-local.js';
import { computeHash } from '../src/hash.js';

describe('local backend', () => {
  let tmpDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'blobsy-local-test-'));
    remoteDir = join(tmpDir, 'remote');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(remoteDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('localPush', () => {
    it('copies file to remote directory', async () => {
      const srcPath = join(tmpDir, 'source.bin');
      await writeFile(srcPath, 'test content');

      await localPush(srcPath, remoteDir, 'key/file.bin');

      const content = await readFile(join(remoteDir, 'key/file.bin'), 'utf-8');
      expect(content).toBe('test content');
    });

    it('creates subdirectories as needed', async () => {
      const srcPath = join(tmpDir, 'source.bin');
      await writeFile(srcPath, 'data');

      await localPush(srcPath, remoteDir, 'deep/nested/path/file.bin');

      expect(existsSync(join(remoteDir, 'deep/nested/path/file.bin'))).toBe(true);
    });
  });

  describe('localPull', () => {
    it('copies file from remote to local', async () => {
      const remoteBlobPath = join(remoteDir, 'key/file.bin');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(remoteDir, 'key'), { recursive: true });
      await writeFile(remoteBlobPath, 'remote content');

      const localPath = join(tmpDir, 'pulled.bin');
      await localPull(remoteDir, 'key/file.bin', localPath);

      const content = await readFile(localPath, 'utf-8');
      expect(content).toBe('remote content');
    });

    it('verifies hash when provided', async () => {
      const remoteBlobPath = join(remoteDir, 'file.bin');
      await writeFile(remoteBlobPath, 'content');
      const hash = await computeHash(remoteBlobPath);

      const localPath = join(tmpDir, 'pulled.bin');
      await localPull(remoteDir, 'file.bin', localPath, hash);

      expect(existsSync(localPath)).toBe(true);
    });

    it('throws on hash mismatch', async () => {
      const remoteBlobPath = join(remoteDir, 'file.bin');
      await writeFile(remoteBlobPath, 'content');

      const localPath = join(tmpDir, 'pulled.bin');
      await expect(
        localPull(
          remoteDir,
          'file.bin',
          localPath,
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        ),
      ).rejects.toThrow('Hash mismatch');
    });

    it('throws when remote blob is missing', async () => {
      const localPath = join(tmpDir, 'pulled.bin');
      await expect(localPull(remoteDir, 'nonexistent.bin', localPath)).rejects.toThrow('not found');
    });
  });

  describe('localBlobExists', () => {
    it('returns true for existing blob', async () => {
      await writeFile(join(remoteDir, 'exists.bin'), 'data');
      expect(localBlobExists(remoteDir, 'exists.bin')).toBe(true);
    });

    it('returns false for missing blob', () => {
      expect(localBlobExists(remoteDir, 'missing.bin')).toBe(false);
    });
  });

  describe('localHealthCheck', () => {
    it('passes for existing writable directory', async () => {
      await expect(localHealthCheck(remoteDir)).resolves.toBeUndefined();
    });

    it('throws for non-existent directory', async () => {
      await expect(localHealthCheck(join(tmpDir, 'nonexistent'))).rejects.toThrow('not found');
    });
  });
});

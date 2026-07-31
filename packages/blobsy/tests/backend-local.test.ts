import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { LocalBackend } from '../src/backend-local.js';
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

  describe('push', () => {
    it('copies file to remote directory', async () => {
      const srcPath = join(tmpDir, 'source.bin');
      await writeFile(srcPath, 'test content');

      await new LocalBackend(remoteDir).push(srcPath, 'key/file.bin');

      const content = await readFile(join(remoteDir, 'key/file.bin'), 'utf-8');
      expect(content).toBe('test content');
    });

    it('creates subdirectories as needed', async () => {
      const srcPath = join(tmpDir, 'source.bin');
      await writeFile(srcPath, 'data');

      await new LocalBackend(remoteDir).push(srcPath, 'deep/nested/path/file.bin');

      expect(existsSync(join(remoteDir, 'deep/nested/path/file.bin'))).toBe(true);
    });
  });

  describe('pull', () => {
    it('copies file from remote to local', async () => {
      const remoteBlobPath = join(remoteDir, 'key/file.bin');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(remoteDir, 'key'), { recursive: true });
      await writeFile(remoteBlobPath, 'remote content');

      const localPath = join(tmpDir, 'pulled.bin');
      await new LocalBackend(remoteDir).pull('key/file.bin', localPath);

      const content = await readFile(localPath, 'utf-8');
      expect(content).toBe('remote content');
    });

    it('verifies hash when provided', async () => {
      const remoteBlobPath = join(remoteDir, 'file.bin');
      await writeFile(remoteBlobPath, 'content');
      const hash = await computeHash(remoteBlobPath);

      const localPath = join(tmpDir, 'pulled.bin');
      await new LocalBackend(remoteDir).pull('file.bin', localPath, hash);

      expect(existsSync(localPath)).toBe(true);
    });

    it('throws on hash mismatch', async () => {
      const remoteBlobPath = join(remoteDir, 'file.bin');
      await writeFile(remoteBlobPath, 'content');

      const localPath = join(tmpDir, 'pulled.bin');
      await expect(
        new LocalBackend(remoteDir).pull(
          'file.bin',
          localPath,
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        ),
      ).rejects.toThrow('Hash mismatch');
    });

    it('throws when remote blob is missing', async () => {
      const localPath = join(tmpDir, 'pulled.bin');
      await expect(new LocalBackend(remoteDir).pull('nonexistent.bin', localPath)).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('exists', () => {
    it('returns true for existing blob', async () => {
      await writeFile(join(remoteDir, 'exists.bin'), 'data');
      expect(await new LocalBackend(remoteDir).exists('exists.bin')).toBe(true);
    });

    it('returns false for missing blob', async () => {
      expect(await new LocalBackend(remoteDir).exists('missing.bin')).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('passes for existing writable directory', async () => {
      await expect(new LocalBackend(remoteDir).healthCheck()).resolves.toBeUndefined();
    });

    it('throws for non-existent directory', async () => {
      await expect(new LocalBackend(join(tmpDir, 'nonexistent')).healthCheck()).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('remote_key containment (BE-03, Bugbot r6)', () => {
    it('rejects keys that escape the backend directory', async () => {
      const backend = new LocalBackend(remoteDir);
      await expect(backend.exists('../../outside.bin')).rejects.toThrow(/escapes the backend/);
      await expect(backend.delete('../outside.bin')).rejects.toThrow(/escapes the backend/);
    });

    it('rejects empty and "." keys that resolve to the store root', async () => {
      const backend = new LocalBackend(remoteDir);
      await expect(backend.exists('')).rejects.toThrow(/escapes the backend/);
      await expect(backend.exists('.')).rejects.toThrow(/escapes the backend/);
      const srcPath = join(tmpDir, 'src.bin');
      await writeFile(srcPath, 'x');
      await expect(backend.push(srcPath, '')).rejects.toThrow(/escapes the backend/);
      await expect(backend.delete('.')).rejects.toThrow(/escapes the backend/);
    });

    it('rejects keys traversing a symlinked directory that points outside (Bugbot r13)', async () => {
      const { mkdir, symlink } = await import('node:fs/promises');
      const outsideDir = join(tmpDir, 'outside');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, 'secret.bin'), 'secret');
      await symlink(outsideDir, join(remoteDir, 'link'), 'dir');

      const backend = new LocalBackend(remoteDir);
      await expect(backend.exists('link/secret.bin')).rejects.toThrow(/escapes the backend/);
      await expect(backend.delete('link/secret.bin')).rejects.toThrow(/escapes the backend/);
      const srcPath = join(tmpDir, 'src2.bin');
      await writeFile(srcPath, 'x');
      await expect(backend.push(srcPath, 'link/new.bin')).rejects.toThrow(/escapes the backend/);
    });

    it('rejects a key that is itself a symlink pointing outside (Bugbot r13)', async () => {
      const { symlink } = await import('node:fs/promises');
      const outsideFile = join(tmpDir, 'target.bin');
      await writeFile(outsideFile, 'secret');
      await symlink(outsideFile, join(remoteDir, 'sneaky.bin'), 'file');

      const backend = new LocalBackend(remoteDir);
      await expect(backend.exists('sneaky.bin')).rejects.toThrow(/escapes the backend/);
      await expect(backend.pull('sneaky.bin', join(tmpDir, 'out.bin'))).rejects.toThrow(
        /escapes the backend/,
      );
    });

    it('still allows normal keys when the store root itself is a symlink', async () => {
      const { mkdir, symlink } = await import('node:fs/promises');
      const realStore = join(tmpDir, 'real-store');
      await mkdir(realStore, { recursive: true });
      const linkedStore = join(tmpDir, 'store-link');
      await symlink(realStore, linkedStore, 'dir');

      const backend = new LocalBackend(linkedStore);
      const srcPath = join(tmpDir, 'src3.bin');
      await writeFile(srcPath, 'ok');
      await backend.push(srcPath, 'sub/file.bin');
      expect(await backend.exists('sub/file.bin')).toBe(true);
    });
  });
});

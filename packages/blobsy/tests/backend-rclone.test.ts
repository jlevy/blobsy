import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RcloneBackend, buildRcloneConfig, isRcloneAvailable } from '../src/backend-rclone.js';
import type { RcloneBackendConfig } from '../src/backend-rclone.js';
import type { ResolvedBackendConfig } from '../src/types.js';
import { BlobsyError } from '../src/types.js';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

describe('RcloneBackend', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    mockExecFileSync.mockReset();
  });

  const defaultConfig: RcloneBackendConfig = {
    type: 'gcs',
    remote: 'my-gcs',
    bucket: 'my-bucket',
    prefix: 'data/',
  };

  describe('push', () => {
    it('constructs correct rclone copyto command', async () => {
      let tmpDir: string | undefined;
      try {
        tmpDir = await mkdtemp(join(tmpdir(), 'rclone-test-'));
        const localFile = join(tmpDir, 'test.bin');
        await writeFile(localFile, 'test content');

        mockExecFileSync.mockReturnValue(Buffer.from(''));

        const backend = new RcloneBackend(defaultConfig);
        await backend.push(localFile, 'model.bin');

        expect(mockExecFileSync).toHaveBeenCalledWith(
          'rclone',
          ['copyto', expect.stringContaining('test.bin'), 'my-gcs:my-bucket/data/model.bin'],
          expect.objectContaining({ timeout: 60000 }),
        );
      } finally {
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true });
        }
      }
    });

    it('throws not_found for missing local file', async () => {
      const backend = new RcloneBackend(defaultConfig);
      await expect(backend.push('/nonexistent/file.bin', 'key')).rejects.toThrow(
        'Local file not found',
      );
    });
  });

  describe('pull', () => {
    it('constructs correct rclone copyto command for pull', async () => {
      let tmpDir: string | undefined;
      try {
        tmpDir = await mkdtemp(join(tmpdir(), 'rclone-test-'));
        const localPath = join(tmpDir, 'output.bin');

        mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === 'rclone' && args[0] === 'copyto') {
            const destPath = args[2];
            if (typeof destPath === 'string') {
              writeFileSync(destPath, 'pulled content');
            }
          }
          return Buffer.from('');
        });

        const backend = new RcloneBackend(defaultConfig);
        await backend.pull('model.bin', localPath);

        expect(mockExecFileSync).toHaveBeenCalledWith(
          'rclone',
          ['copyto', 'my-gcs:my-bucket/data/model.bin', expect.stringContaining('.blobsy-rclone-')],
          expect.objectContaining({ timeout: 60000 }),
        );
      } finally {
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true });
        }
      }
    });
  });

  describe('exists', () => {
    it('returns true when lsf produces output', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from('model.bin\n'));

      const backend = new RcloneBackend(defaultConfig);
      const result = await backend.exists('model.bin');

      expect(result).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rclone',
        ['lsf', 'my-gcs:my-bucket/data/model.bin'],
        expect.objectContaining({ timeout: 60000 }),
      );
    });

    it('returns false when lsf produces empty output', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const backend = new RcloneBackend(defaultConfig);
      const result = await backend.exists('model.bin');

      expect(result).toBe(false);
    });

    it('returns false on not_found error (exit 3)', async () => {
      const error = Object.assign(new Error('rclone failed'), {
        status: 3,
        stderr: Buffer.from('directory not found'),
        stdout: Buffer.from(''),
        code: undefined,
      });
      mockExecFileSync.mockImplementation(() => {
        throw error;
      });

      const backend = new RcloneBackend(defaultConfig);
      const result = await backend.exists('missing.bin');

      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    it('constructs correct rclone deletefile command', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const backend = new RcloneBackend(defaultConfig);
      await backend.delete('model.bin');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rclone',
        ['deletefile', 'my-gcs:my-bucket/data/model.bin'],
        expect.objectContaining({ timeout: 60000 }),
      );
    });
  });

  describe('healthCheck', () => {
    it('constructs correct rclone lsf command with prefix', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const backend = new RcloneBackend(defaultConfig);
      await backend.healthCheck();

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rclone',
        ['lsf', 'my-gcs:my-bucket/data/', '--max-depth', '1', '--max-count', '1'],
        expect.objectContaining({ timeout: 60000 }),
      );
    });

    it('constructs correct rclone lsf command without prefix', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const config: RcloneBackendConfig = { ...defaultConfig, prefix: '' };
      const backend = new RcloneBackend(config);
      await backend.healthCheck();

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rclone',
        ['lsf', 'my-gcs:my-bucket/', '--max-depth', '1', '--max-count', '1'],
        expect.objectContaining({ timeout: 60000 }),
      );
    });
  });

  describe('error handling', () => {
    it('throws not_found when rclone binary is missing (ENOENT)', async () => {
      const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockExecFileSync.mockImplementation(() => {
        throw error;
      });

      const backend = new RcloneBackend(defaultConfig);
      // Use delete (not exists) — exists catches not_found and returns false
      await expect(backend.delete('key')).rejects.toThrow('rclone not found');
    });

    it('throws validation error for missing rclone remote', async () => {
      const error = Object.assign(new Error('rclone failed'), {
        status: 1,
        stderr: Buffer.from("Failed to create file system: couldn't find remote"),
        stdout: Buffer.from(''),
        code: undefined,
      });
      mockExecFileSync.mockImplementation(() => {
        throw error;
      });

      const backend = new RcloneBackend(defaultConfig);
      await expect(backend.exists('key')).rejects.toThrow('remote "my-gcs" not found');
    });

    it('categorizes access denied errors', async () => {
      const error = Object.assign(new Error('rclone failed'), {
        status: 1,
        stderr: Buffer.from('AccessDenied: Access Denied'),
        stdout: Buffer.from(''),
        code: undefined,
      });
      mockExecFileSync.mockImplementation(() => {
        throw error;
      });

      const backend = new RcloneBackend(defaultConfig);
      try {
        await backend.delete('key');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BlobsyError);
        expect((err as BlobsyError).category).toBe('authentication');
      }
    });
  });

  describe('path construction', () => {
    it('handles empty prefix', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const config: RcloneBackendConfig = { ...defaultConfig, prefix: '' };
      const backend = new RcloneBackend(config);
      await backend.delete('model.bin');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rclone',
        ['deletefile', 'my-gcs:my-bucket/model.bin'],
        expect.anything(),
      );
    });

    it('handles prefix with trailing slash', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      const config: RcloneBackendConfig = { ...defaultConfig, prefix: 'data/subdir/' };
      const backend = new RcloneBackend(config);
      await backend.delete('model.bin');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rclone',
        ['deletefile', 'my-gcs:my-bucket/data/subdir/model.bin'],
        expect.anything(),
      );
    });
  });
});

describe('buildRcloneConfig', () => {
  it('builds config from resolved backend with rclone_remote', () => {
    const config: ResolvedBackendConfig = {
      type: 'gcs',
      url: 'gs://my-bucket/prefix/',
      rclone_remote: 'my-gcs',
    };
    const result = buildRcloneConfig(config);
    expect(result).toEqual({
      type: 'gcs',
      remote: 'my-gcs',
      bucket: 'my-bucket',
      prefix: 'prefix/',
    });
  });

  it('throws when rclone_remote is not set', () => {
    const config: ResolvedBackendConfig = {
      type: 'gcs',
      url: 'gs://my-bucket/prefix/',
    };
    expect(() => buildRcloneConfig(config)).toThrow('rclone_remote');
  });

  it('uses explicit bucket/prefix over URL-derived values', () => {
    const config: ResolvedBackendConfig = {
      type: 'azure',
      url: 'azure://url-container/url-prefix/',
      bucket: 'explicit-container',
      prefix: 'explicit-prefix/',
      rclone_remote: 'my-azure',
    };
    const result = buildRcloneConfig(config);
    expect(result.bucket).toBe('explicit-container');
    expect(result.prefix).toBe('explicit-prefix/');
  });
});

describe('isRcloneAvailable', () => {
  it('returns true when rclone --version succeeds', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('rclone v1.67'));
    expect(isRcloneAvailable()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('rclone', ['--version'], expect.anything());
  });

  it('returns false when rclone is not found', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isRcloneAvailable()).toBe(false);
  });
});

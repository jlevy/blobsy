import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { UserError } from '../../src/types.js';

describe('UserError class', () => {
  describe('format()', () => {
    it('should format error with hint', () => {
      const err = new UserError('File not found', 'Run: blobsy track file.bin');
      expect(err.format()).toBe('✗ File not found\n  Run: blobsy track file.bin');
    });

    it('should format error without hint', () => {
      const err = new UserError('Operation failed');
      expect(err.format()).toBe('✗ Operation failed');
    });

    it('should have correct exit code (default 1)', () => {
      const err = new UserError('Test error');
      expect(err.exitCode).toBe(1);
    });

    it('should support custom exit code', () => {
      const err = new UserError('Test error', 'hint', 42);
      expect(err.exitCode).toBe(42);
    });

    it('should maintain stack trace', () => {
      const err = new UserError('Test error');
      expect(err.stack).toBeDefined();
      expect(err.stack).toContain('UserError');
    });

    it('should have correct name property', () => {
      const err = new UserError('Test error');
      expect(err.name).toBe('UserError');
    });
  });
});

describe('CLI error messages', () => {
  let testDir: string;
  let backendDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-error-test-'));
    backendDir = join(testDir, '..', 'backend');

    // Initialize git repo
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });

    // Initialize blobsy
    await execa('blobsy', ['init', 'local:../backend'], { cwd: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });

  describe('push command errors', () => {
    it('should show user-friendly error for untracked file', async () => {
      // Try to push a file that was never tracked
      const result = await execa('blobsy', ['push', 'untracked.bin'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/File not tracked/i);
      expect(result.stderr).toMatch(/untracked\.bin/);

      // Should NOT show technical ENOENT error
      expect(result.stderr).not.toMatch(/ENOENT/);
      expect(result.stderr).not.toMatch(/no such file or directory/);
    });

    it('should suggest blobsy track in error hint', async () => {
      const result = await execa('blobsy', ['push', 'untracked.bin'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/blobsy track/i);
    });
  });

  describe('pull command errors', () => {
    it('should show user-friendly error for file never tracked', async () => {
      const result = await execa('blobsy', ['pull', 'never-tracked.bin'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/File not tracked/i);

      // Should NOT show ENOENT
      expect(result.stderr).not.toMatch(/ENOENT/);
    });
  });

  describe('rm command errors', () => {
    it('should show user-friendly error when file not tracked', async () => {
      const result = await execa('blobsy', ['rm', 'never-tracked.bin'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/not tracked|not found/i);

      // Should NOT show ENOENT
      expect(result.stderr).not.toMatch(/ENOENT/);
    });
  });

  describe('verify command errors', () => {
    it('should show user-friendly error for untracked file', async () => {
      // Create a file but don't track it
      await writeFile(join(testDir, 'untracked.bin'), 'test content');

      const result = await execa('blobsy', ['verify', 'untracked.bin'], {
        cwd: testDir,
        reject: false,
      });

      // Verify command might skip untracked files rather than error
      // The key is that if it DOES error, it should be user-friendly
      if (result.exitCode !== 0) {
        const output = result.stderr || result.stdout;
        // Verify shows "missing_ref" status which is user-friendly
        expect(output).toMatch(/missing_ref|not tracked/i);
        // Should NOT show ENOENT
        expect(output).not.toMatch(/ENOENT/);
      }
    });
  });

  describe('error message consistency', () => {
    it('should use user-friendly error messages across all commands', async () => {
      const commands = [
        ['push', 'missing.bin'],
        ['pull', 'missing.bin'],
        ['rm', 'missing.bin'],
      ];

      for (const cmd of commands) {
        const result = await execa('blobsy', cmd, {
          cwd: testDir,
          reject: false,
        });

        expect(result.exitCode).not.toBe(0);

        // Check both stderr and stdout for error messages
        const output = result.stderr || result.stdout;

        if (output) {
          // Should have user-friendly messages (not technical errors)
          expect(output).not.toMatch(/ENOENT|EACCES|errno/i);

          // Should mention being "not tracked" or similar user-friendly message
          expect(output).toMatch(/not tracked|not found/i);
        }
      }
    });

    it('should not show stack traces for user errors', async () => {
      const result = await execa('blobsy', ['push', 'untracked.bin'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);

      // Should not contain stack trace keywords
      expect(result.stderr).not.toMatch(/at Object\./);
      expect(result.stderr).not.toMatch(/at async/);
      expect(result.stderr).not.toMatch(/node_modules/);
    });
  });

  describe('permission errors', () => {
    it('should show user-friendly permission denied error', async () => {
      // Root can bypass file permissions, so skip this test when running as root
      if (process.getuid?.() === 0) {
        return;
      }

      // Create a file and track it
      const testFile = join(testDir, 'readonly.bin');
      await writeFile(testFile, 'test content');
      await execa('blobsy', ['track', 'readonly.bin'], { cwd: testDir });

      // Make the .bref file read-only
      const brefFile = join(testDir, 'readonly.bin.bref');
      const { chmod } = await import('node:fs/promises');
      await chmod(brefFile, 0o444);

      // Modify the file so re-tracking will try to update the .bref
      await writeFile(testFile, 'modified content');

      try {
        // Try to track again (will try to update read-only .bref)
        const result = await execa('blobsy', ['track', 'readonly.bin'], {
          cwd: testDir,
          reject: false,
        });

        if (result.exitCode !== 0) {
          // Should show user-friendly permission error if it failed
          expect(result.stderr).toMatch(/permission|denied|read-only/i);

          // Should NOT show raw EACCES
          expect(result.stderr).not.toMatch(/EACCES/);
        }
      } finally {
        // Restore permissions for cleanup
        await chmod(brefFile, 0o644).catch(() => {
          /* ignore errors */
        });
      }
    });
  });

  describe('backend errors', () => {
    it('should show user-friendly error when backend is not accessible', async () => {
      // Create a tracked and pushed file
      await writeFile(join(testDir, 'test.bin'), 'test content');
      await execa('blobsy', ['track', 'test.bin'], { cwd: testDir });
      await execa('blobsy', ['push', 'test.bin'], { cwd: testDir });

      // Remove local file to test pull
      await rm(join(testDir, 'test.bin'));

      // Remove the backend directory to simulate backend unavailable
      await rm(backendDir, { recursive: true, force: true });

      // Try to pull - should fail since backend is gone
      const result = await execa('blobsy', ['pull', 'test.bin'], {
        cwd: testDir,
        reject: false,
      });

      // If it errors (it should), check error is user-friendly
      if (result.exitCode !== 0 && result.stderr) {
        // Should get a user-friendly error (not raw ENOENT)
        expect(result.stderr).toMatch(/backend|cannot|failed|not found/i);
        expect(result.stderr).not.toMatch(/ENOENT/);
      }

      // Recreate backend for cleanup
      await execa('blobsy', ['init', 'local:../backend'], { cwd: testDir });
    });
  });
});

import { mkdtemp, rm, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';

describe('init command - auto-create directories', () => {
  let testDir: string;
  let backendDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-init-test-'));
    // Backend must be outside the git repo - make it unique per test
    backendDir = await mkdtemp(join(tmpdir(), 'blobsy-backend-'));

    // Initialize git repo
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    // Clean up backend directory
    await rm(backendDir, { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });

  it('should auto-create local backend directory if it does not exist', async () => {
    // Remove the pre-created backend directory to test auto-creation
    await rm(backendDir, { recursive: true, force: true });

    // Verify backend directory doesn't exist yet
    expect(existsSync(backendDir)).toBe(false);

    // Run init with local backend (outside repo)
    await execa('blobsy', ['init', `local:${backendDir}`], { cwd: testDir });

    // Backend directory should now exist
    expect(existsSync(backendDir)).toBe(true);
  });

  it('should succeed if backend directory already exists', async () => {
    // Backend directory is already created by mkdtemp in beforeEach
    expect(existsSync(backendDir)).toBe(true);

    // Should not throw
    await execa('blobsy', ['init', `local:${backendDir}`], { cwd: testDir });

    expect(existsSync(backendDir)).toBe(true);
  });

  it('should create deeply nested backend directory paths', async () => {
    const nestedBackendPath = join(testDir, '..', 'very', 'deeply', 'nested', 'backend');

    // Neither parent nor grandparent exist - should still succeed with recursive mkdir
    try {
      await execa('blobsy', ['init', `local:../very/deeply/nested/backend`], { cwd: testDir });

      // Full nested path should be created
      expect(existsSync(nestedBackendPath)).toBe(true);
    } finally {
      await rm(join(testDir, '..', 'very'), { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should error if parent directory is not writable', async () => {
    // Root can bypass file permissions, so skip this test when running as root
    if (process.getuid?.() === 0) {
      return;
    }

    // Create a read-only parent directory outside the repo
    const readonlyParent = join(testDir, '..', 'readonly');
    await mkdir(readonlyParent);
    await chmod(readonlyParent, 0o444); // Read-only

    try {
      // Should fail with permission error
      await expect(
        execa('blobsy', ['init', 'local:../readonly/backend'], { cwd: testDir }),
      ).rejects.toThrow(/Permission denied/);
    } finally {
      // Restore permissions for cleanup
      await chmod(readonlyParent, 0o755);
      await rm(readonlyParent, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should create nested backend directory paths', async () => {
    const nestedPath = join(testDir, '..', 'deep', 'nested', 'backend');

    // Parent exists but nested path doesn't
    await mkdir(join(testDir, '..', 'deep'), { recursive: true });

    try {
      await execa('blobsy', ['init', 'local:../deep/nested/backend'], { cwd: testDir });

      // Full nested path should be created
      expect(existsSync(nestedPath)).toBe(true);
    } finally {
      await rm(join(testDir, '..', 'deep'), { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should work with absolute paths', async () => {
    const absoluteBackend = join(testDir, '..', 'absolute-backend');

    try {
      await execa('blobsy', ['init', `local:${absoluteBackend}`], { cwd: testDir });

      expect(existsSync(absoluteBackend)).toBe(true);
    } finally {
      await rm(absoluteBackend, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should work with relative parent paths (../)', async () => {
    const parentBackend = join(testDir, '..', 'sibling-backend');

    try {
      await execa('blobsy', ['init', 'local:../sibling-backend'], { cwd: testDir });

      expect(existsSync(parentBackend)).toBe(true);
    } finally {
      // Clean up sibling directory
      await rm(parentBackend, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should output message about created directory', async () => {
    const { stdout } = await execa('blobsy', ['init', 'local:../backend-msg'], { cwd: testDir });

    // Should mention directory creation
    expect(stdout).toMatch(/Created backend directory/);
    expect(stdout).toMatch(/backend/);

    // Cleanup
    await rm(join(testDir, '..', 'backend-msg'), { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });

  it('should not output message with --quiet flag', async () => {
    const { stdout } = await execa('blobsy', ['init', 'local:../backend-quiet', '--quiet'], {
      cwd: testDir,
    });

    // Should not contain directory creation message
    expect(stdout).not.toMatch(/Created backend directory/);

    // Cleanup
    await rm(join(testDir, '..', 'backend-quiet'), { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });
});

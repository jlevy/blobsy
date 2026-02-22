import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';

describe('hooks command - absolute path', () => {
  let testDir: string;
  let hookPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-hooks-test-'));
    hookPath = join(testDir, '.git', 'hooks', 'pre-commit');

    // Initialize git repo
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });

    // Initialize blobsy
    await execa('blobsy', ['init', 'local:../backend'], { cwd: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    // Clean up backend directory
    const backendDir = join(testDir, '..', 'backend');
    await rm(backendDir, { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });

  it('should write absolute path to hook file', async () => {
    // Install hooks
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    // Read hook file
    const hookContent = await readFile(hookPath, 'utf-8');

    // Should contain absolute path (either blobsy binary or cli.mjs)
    // The path should be absolute and executable
    expect(hookContent).toMatch(/exec "\/[^"]*" hook pre-commit/);
    // Should NOT be a bare "blobsy" command without a path
    expect(hookContent).not.toMatch(/^exec blobsy hook pre-commit$/m);

    // Verify the path is absolute
    const match = /exec "([^"]+)" hook pre-commit/.exec(hookContent);
    expect(match).toBeTruthy();
    if (match) {
      const execPath = match[1];
      expect(execPath).toMatch(/^\//); // Must be absolute path
    }
  });

  it('should use hashbang and be executable', async () => {
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    const hookContent = await readFile(hookPath, 'utf-8');

    // Should have hashbang
    expect(hookContent).toMatch(/^#!/);
    expect(hookContent).toMatch(/\/bin\/sh/);

    // Check if executable (on Unix systems)
    if (process.platform !== 'win32') {
      const stats = await readFile(hookPath).then(async () => {
        const { stat } = await import('fs/promises');
        return stat(hookPath);
      });

      // Check execute bit (0o111 = --x--x--x)
      expect(stats.mode & 0o111).not.toBe(0);
    }
  });

  it('should include installation comments in hook', async () => {
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    const hookContent = await readFile(hookPath, 'utf-8');

    // Should have helpful comments
    expect(hookContent).toMatch(/Installed by: blobsy hooks install/);
    expect(hookContent).toMatch(/To bypass: git commit --no-verify/);
  });

  it('should execute hook successfully with absolute path', async () => {
    // Install hooks
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    // Track a file
    await writeFile(join(testDir, 'test.bin'), 'test content');
    await execa('blobsy', ['track', 'test.bin'], { cwd: testDir });

    // Stage the file
    await execa('git', ['add', '.'], { cwd: testDir });

    // Try to commit - hook should execute
    // (It will fail because file isn't pushed, but hook should execute)
    const result = await execa('git', ['commit', '-m', 'test'], {
      cwd: testDir,
      reject: false,
    });

    // Hook should have executed (not a "command not found" error)
    expect(result.stderr || result.stdout).not.toMatch(/blobsy: not found/);
    expect(result.stderr || result.stdout).not.toMatch(/command not found/);
  });

  it('should uninstall hook correctly', async () => {
    // Install first
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });
    expect(existsSync(hookPath)).toBe(true);

    // Uninstall
    await execa('blobsy', ['hooks', 'uninstall'], { cwd: testDir });

    // Hook should be removed
    expect(existsSync(hookPath)).toBe(false);
  });

  it('should error on invalid hook action', async () => {
    // Unknown action should fail
    await expect(execa('blobsy', ['hooks', 'status'], { cwd: testDir })).rejects.toThrow(
      /Unknown hooks action/,
    );
  });

  it('should detect blobsy executable path correctly', async () => {
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    const hookContent = await readFile(hookPath, 'utf-8');

    // Extract the blobsy path from the hook
    const match = /exec "([^"]+)" hook pre-commit/.exec(hookContent);
    expect(match).toBeTruthy();
    expect(match?.[1]).toBeTruthy();

    if (match?.[1]) {
      const blobsyPath = match[1];

      // Path should be absolute
      expect(blobsyPath).toMatch(/^\//);

      // Path should contain "blobsy"
      expect(blobsyPath).toMatch(/blobsy/);

      // The file should exist and be executable
      expect(existsSync(blobsyPath)).toBe(true);
    }
  });

  it('should work even if installed multiple times', async () => {
    // Install twice
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });
    await execa('blobsy', ['hooks', 'install'], { cwd: testDir });

    // Should still work
    expect(existsSync(hookPath)).toBe(true);

    const hookContent = await readFile(hookPath, 'utf-8');
    // Should have absolute path
    expect(hookContent).toMatch(/exec "\/[^"]*" hook pre-commit/);
  });
});

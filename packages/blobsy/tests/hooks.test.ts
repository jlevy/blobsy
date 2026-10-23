import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { blobsy } from './helpers/cli.js';

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
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: testDir });

    // Initialize blobsy
    await blobsy(['init', 'local:../backend'], { cwd: testDir });
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
    await blobsy(['hooks', 'install'], { cwd: testDir });

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
    await blobsy(['hooks', 'install'], { cwd: testDir });

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
    await blobsy(['hooks', 'install'], { cwd: testDir });

    const hookContent = await readFile(hookPath, 'utf-8');

    // Should have helpful comments
    expect(hookContent).toMatch(/Installed by: blobsy hooks install/);
    expect(hookContent).toMatch(/To bypass: git commit --no-verify/);
  });

  it('should execute hook successfully with absolute path', async () => {
    // Install hooks
    await blobsy(['hooks', 'install'], { cwd: testDir });

    // Track a file
    await writeFile(join(testDir, 'test.bin'), 'test content');
    await blobsy(['track', 'test.bin'], { cwd: testDir });

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
    await blobsy(['hooks', 'install'], { cwd: testDir });
    expect(existsSync(hookPath)).toBe(true);

    // Uninstall
    await blobsy(['hooks', 'uninstall'], { cwd: testDir });

    // Hook should be removed
    expect(existsSync(hookPath)).toBe(false);
  });

  it('should error on invalid hook action', async () => {
    // Unknown action should fail
    await expect(blobsy(['hooks', 'status'], { cwd: testDir })).rejects.toThrow(
      /Unknown hooks action/,
    );
  });

  it('should detect blobsy executable path correctly', async () => {
    await blobsy(['hooks', 'install'], { cwd: testDir });

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
    await blobsy(['hooks', 'install'], { cwd: testDir });
    await blobsy(['hooks', 'install'], { cwd: testDir });

    // Should still work
    expect(existsSync(hookPath)).toBe(true);

    const hookContent = await readFile(hookPath, 'utf-8');
    // Should have absolute path
    expect(hookContent).toMatch(/exec "\/[^"]*" hook pre-commit/);
  });
});

describe('hook ownership (HK-03)', () => {
  const userHook = '#!/bin/sh\nnpm test\nblobsy hook pre-commit\ngitleaks protect\n';
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-hook-own-test-'));
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    await blobsy(['init', '--no-hooks', 'local:../own-backend'], {
      cwd: testDir,
      env: { ...process.env, BLOBSY_NO_HOOKS: '' },
    });
  });

  afterEach(async () => {
    const backendDir = join(testDir, '..', 'own-backend');
    await rm(testDir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  });

  it('hooks install leaves a user-owned hook in place even if it calls blobsy', async () => {
    const hookPath = join(testDir, '.git', 'hooks', 'pre-commit');
    await mkdir(join(testDir, '.git', 'hooks'), { recursive: true });
    await writeFile(hookPath, userHook);

    const result = await blobsy(['hooks', 'install'], { cwd: testDir });
    expect(result.stdout).toMatch(/not managed by blobsy/);
    expect(await readFile(hookPath, 'utf-8')).toBe(userHook);
  });

  it('hooks uninstall never deletes a user-owned hook that mentions blobsy', async () => {
    const hookPath = join(testDir, '.git', 'hooks', 'pre-push');
    await mkdir(join(testDir, '.git', 'hooks'), { recursive: true });
    await writeFile(hookPath, userHook);

    const result = await blobsy(['hooks', 'uninstall'], { cwd: testDir });
    expect(result.stdout).toMatch(/not managed by blobsy/);
    expect(await readFile(hookPath, 'utf-8')).toBe(userHook);
  });

  it('hooks install rewrites its own previously installed hook', async () => {
    await blobsy(['hooks', 'install'], { cwd: testDir });
    const hookPath = join(testDir, '.git', 'hooks', 'pre-commit');
    const first = await readFile(hookPath, 'utf-8');
    expect(first).toContain('# Installed by: blobsy hooks install');

    const result = await blobsy(['hooks', 'install'], { cwd: testDir });
    expect(result.stdout).toMatch(/Installed pre-commit hook/);
  });
});

describe('BLOBSY_NO_HOOKS opt-out consistency', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-nohooks-test-'));
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    await blobsy(['init', '--no-hooks', 'local:../nohooks-backend'], { cwd: testDir });
  });

  afterEach(async () => {
    const backendDir = join(testDir, '..', 'nohooks-backend');
    await rm(testDir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  });

  it('hooks install refuses when BLOBSY_NO_HOOKS is set', async () => {
    const result = await blobsy(['hooks', 'install'], {
      cwd: testDir,
      env: { BLOBSY_NO_HOOKS: '1' },
    });
    expect(result.stdout).toMatch(/BLOBSY_NO_HOOKS is set; not installing hooks/);
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  it('doctor --fix does not install hooks when BLOBSY_NO_HOOKS is set', async () => {
    const result = await blobsy(['doctor', '--fix'], {
      cwd: testDir,
      env: { BLOBSY_NO_HOOKS: '1' },
      reject: false,
    });
    expect(result.stdout).toMatch(/BLOBSY_NO_HOOKS is set; not installing/);
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  it('explicit negatives (0, false) do not act as the kill switch', async () => {
    // A user re-enabling hooks after a parent-shell export sets the
    // variable to "0" or "false"; only affirmative values may opt out.
    for (const value of ['0', 'false']) {
      const result = await blobsy(['hooks', 'install'], {
        cwd: testDir,
        env: { BLOBSY_NO_HOOKS: value },
      });
      expect(result.stdout).not.toMatch(/BLOBSY_NO_HOOKS is set/);
      expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(true);
      await blobsy(['hooks', 'uninstall'], { cwd: testDir });
    }
  });
});

describe('worktree and core.hooksPath support (HK-04)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-hk04-test-'));
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: testDir });
    await blobsy(['init', '--no-hooks', 'local:../hk04-backend'], { cwd: testDir });
    await execa('git', ['add', '-A'], { cwd: testDir });
    await execa('git', ['commit', '-m', 'init'], { cwd: testDir });
  });

  afterEach(async () => {
    const backendDir = join(testDir, '..', 'hk04-backend');
    const worktreeDir = join(testDir, '..', 'hk04-worktree');
    await rm(worktreeDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
    await rm(testDir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
  });

  it('installs into the shared hooks dir when run from a linked worktree', async () => {
    const worktreeDir = join(testDir, '..', 'hk04-worktree');
    await execa('git', ['worktree', 'add', worktreeDir, '-b', 'hk04-branch'], { cwd: testDir });

    const result = await blobsy(['hooks', 'install'], { cwd: worktreeDir });
    expect(result.stdout).toMatch(/Installed pre-commit hook/);

    // In a linked worktree .git is a file; hooks live in the main repo's
    // .git/hooks. The old join(root, '.git', 'hooks') would have failed.
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-push'))).toBe(true);
  });

  it('honors core.hooksPath when set', async () => {
    await execa('git', ['config', 'core.hooksPath', '.githooks'], { cwd: testDir });

    const result = await blobsy(['hooks', 'install'], { cwd: testDir });
    expect(result.stdout).toMatch(/Installed pre-commit hook/);

    expect(existsSync(join(testDir, '.githooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('hooks uninstall removes hooks from the shared dir when run from a worktree', async () => {
    const worktreeDir = join(testDir, '..', 'hk04-worktree');
    await execa('git', ['worktree', 'add', worktreeDir, '-b', 'hk04-branch'], { cwd: testDir });

    await blobsy(['hooks', 'install'], { cwd: worktreeDir });
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(true);

    const result = await blobsy(['hooks', 'uninstall'], { cwd: worktreeDir });
    expect(result.stdout).toMatch(/Uninstalled pre-commit hook/);
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });
});

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { blobsy, CLI_PATH } from '../helpers/cli.js';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

describe('rm command with --remote flag', () => {
  let testDir: string;
  let backendDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-rm-test-'));
    backendDir = await mkdtemp(join(tmpdir(), 'blobsy-rm-backend-'));

    // Initialize git repo
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });

    // Initialize blobsy
    await blobsy(['init', `local:${backendDir}`], { cwd: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(backendDir, { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  });

  describe('basic --remote deletion', () => {
    it('should delete remote blob with --remote --force flags', async () => {
      // Setup: create, track, and push a file
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });

      // Push to ensure remote_key is set
      const pushResult = await blobsy(['push', 'file.bin'], { cwd: testDir });
      expect(pushResult.exitCode).toBe(0);

      // Read the .bref to get remote_key before deletion
      const brefPath = join(testDir, 'file.bin.bref');
      const brefContent = await readFile(brefPath, 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      const remoteKey = bref.remote_key;

      expect(remoteKey).toBeDefined();
      expect(typeof remoteKey).toBe('string');

      // Construct backend blob path (might have subdirectories)
      const backendBlobPath = join(backendDir, remoteKey!);

      // Verify blob exists in backend
      expect(existsSync(backendBlobPath)).toBe(true);

      // Delete with --remote --force (skip confirmation)
      const result = await blobsy(['rm', 'file.bin', '--remote', '--force'], {
        cwd: testDir,
      });

      expect(result.exitCode).toBe(0);

      // Verify blob was deleted from backend
      expect(existsSync(backendBlobPath)).toBe(false);

      // Verify local file was removed
      expect(existsSync(join(testDir, 'file.bin'))).toBe(false);

      // Verify .bref was moved to trash
      expect(existsSync(brefPath)).toBe(false);
      const trashDir = join(testDir, '.blobsy', 'trash');
      expect(existsSync(trashDir)).toBe(true);
    });

    it('should show success message when deleting from backend', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });

      // Push and verify remote_key is set
      await blobsy(['push', 'file.bin'], { cwd: testDir });
      const brefContent = await readFile(join(testDir, 'file.bin.bref'), 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      expect(bref.remote_key).toBeDefined();

      const result = await blobsy(['rm', 'file.bin', '--remote', '--force'], {
        cwd: testDir,
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout + '\n' + result.stderr;
      expect(output).toMatch(/Deleted from backend/i);
    });

    it('should not show deletion message with --quiet flag', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });
      await blobsy(['push', 'file.bin'], { cwd: testDir });

      const result = await blobsy(['rm', 'file.bin', '--remote', '--force', '--quiet'], {
        cwd: testDir,
      });

      expect(result.stdout).toBe('');
    });
  });

  describe('--remote without --force (DS-04: no prompt, refuse up front)', () => {
    it('refuses with a history-breaking error and mutates nothing', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });
      await blobsy(['push', 'file.bin'], { cwd: testDir });

      const brefContent = await readFile(join(testDir, 'file.bin.bref'), 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      expect(bref.remote_key).toBeDefined();
      const backendBlobPath = join(backendDir, bref.remote_key!);
      expect(existsSync(backendBlobPath)).toBe(true);

      const result = await blobsy(['rm', 'file.bin', '--remote'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/git history/i);
      expect(result.stderr).toMatch(/--force/);

      // Refusal happens before any local mutation: everything intact.
      expect(existsSync(join(testDir, 'file.bin'))).toBe(true);
      expect(existsSync(join(testDir, 'file.bin.bref'))).toBe(true);
      expect(existsSync(backendBlobPath)).toBe(true);
    });

    it('refuses even with --quiet (quiet must never imply consent)', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });
      await blobsy(['push', 'file.bin'], { cwd: testDir });

      const brefContent = await readFile(join(testDir, 'file.bin.bref'), 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      expect(bref.remote_key).toBeDefined();
      const backendBlobPath = join(backendDir, bref.remote_key!);

      const result = await blobsy(['rm', 'file.bin', '--remote', '--quiet'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(backendBlobPath)).toBe(true);
      expect(existsSync(join(testDir, 'file.bin'))).toBe(true);
    });

    it('never opens an interactive prompt (exits without consuming stdin)', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });
      await blobsy(['push', 'file.bin'], { cwd: testDir });

      // With stdin an open pipe and no input written, a prompting
      // implementation would hang; the command must exit immediately.
      const child = spawn(process.execPath, [CLI_PATH, 'rm', 'file.bin', '--remote'], {
        cwd: testDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => {
          resolve(code ?? 0);
        });
      });

      expect(exitCode).not.toBe(0);
    });
  });

  describe('flag validation', () => {
    it('should error when using both --local and --remote', async () => {
      const result = await blobsy(['rm', 'file.bin', '--local', '--remote'], {
        cwd: testDir,
        reject: false,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/Cannot use both --local and --remote/);
    });
  });

  describe('unpushed files', () => {
    it('should handle unpushed files gracefully with --remote', async () => {
      // Create and track file but DON'T push
      await writeFile(join(testDir, 'unpushed.bin'), 'test content');
      await blobsy(['track', 'unpushed.bin'], { cwd: testDir });

      // Should complete without error (just note that file wasn't pushed)
      const result = await blobsy(['rm', 'unpushed.bin', '--remote', '--force'], {
        cwd: testDir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/never pushed|skipping backend deletion/i);
    });

    it('should not error on unpushed file deletion', async () => {
      await writeFile(join(testDir, 'unpushed.bin'), 'test content');
      await blobsy(['track', 'unpushed.bin'], { cwd: testDir });

      // Verify file has no remote_key
      const brefContent = await readFile(join(testDir, 'unpushed.bin.bref'), 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      expect(bref.remote_key).toBeUndefined();

      // Delete with --remote should succeed
      const result = await blobsy(['rm', 'unpushed.bin', '--remote', '--force'], {
        cwd: testDir,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(testDir, 'unpushed.bin'))).toBe(false);
    });
  });

  describe('default behavior (without --remote)', () => {
    it('should keep remote blob by default (without --remote flag)', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });
      await blobsy(['push', 'file.bin'], { cwd: testDir });

      // Get remote_key
      const brefContent = await readFile(join(testDir, 'file.bin.bref'), 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      const remoteKey = bref.remote_key!;
      const backendBlobPath = join(backendDir, remoteKey);

      expect(existsSync(backendBlobPath)).toBe(true);

      // Delete WITHOUT --remote flag
      await blobsy(['rm', 'file.bin'], { cwd: testDir });

      // Blob should STILL exist in backend
      expect(existsSync(backendBlobPath)).toBe(true);

      // Local file should be removed
      expect(existsSync(join(testDir, 'file.bin'))).toBe(false);
    });
  });

  describe('multiple files', () => {
    it('should delete multiple files from backend with --remote', async () => {
      // Create and push multiple files
      await writeFile(join(testDir, 'file1.bin'), 'content 1');
      await writeFile(join(testDir, 'file2.bin'), 'content 2');
      await blobsy(['track', 'file1.bin', 'file2.bin'], { cwd: testDir });
      await blobsy(['push'], { cwd: testDir });

      // Get remote keys
      const bref1 = parseYaml(await readFile(join(testDir, 'file1.bin.bref'), 'utf-8')) as {
        remote_key?: string;
      };
      const bref2 = parseYaml(await readFile(join(testDir, 'file2.bin.bref'), 'utf-8')) as {
        remote_key?: string;
      };

      const blob1Path = join(backendDir, bref1.remote_key!);
      const blob2Path = join(backendDir, bref2.remote_key!);

      expect(existsSync(blob1Path)).toBe(true);
      expect(existsSync(blob2Path)).toBe(true);

      // Delete both with --remote --force
      await blobsy(['rm', 'file1.bin', 'file2.bin', '--remote', '--force'], {
        cwd: testDir,
      });

      // Both blobs should be deleted
      expect(existsSync(blob1Path)).toBe(false);
      expect(existsSync(blob2Path)).toBe(false);
    });
  });

  describe('backend errors', () => {
    it('exits 1 if backend deletion fails, after completing local cleanup', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });
      await blobsy(['push', 'file.bin'], { cwd: testDir });

      // Get remote key and manually delete blob to simulate backend error
      const brefContent = await readFile(join(testDir, 'file.bin.bref'), 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      const backendBlobPath = join(backendDir, bref.remote_key!);

      // Delete blob manually
      await rm(backendBlobPath);

      // Now try to delete with --remote - backend deletion will fail
      const result = await blobsy(['rm', 'file.bin', '--remote', '--force'], {
        cwd: testDir,
        reject: false,
      });

      // The destructive half of --remote --force did not happen, so the
      // command must fail overall — automation reads the exit code.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Failed to delete from backend/);
      expect(result.stderr).toMatch(/Remote blob still exists/);

      // Local cleanup still completes: partial state is reported, not
      // rolled back.
      expect(existsSync(join(testDir, 'file.bin'))).toBe(false);
      expect(existsSync(join(testDir, 'file.bin.bref'))).toBe(false);
    });
  });

  describe('--local flag behavior', () => {
    it('should keep .bref with --local flag (for re-pull)', async () => {
      await writeFile(join(testDir, 'file.bin'), 'test content');
      await blobsy(['track', 'file.bin'], { cwd: testDir });
      await blobsy(['push', 'file.bin'], { cwd: testDir });

      // Delete with --local (removes only local file)
      await blobsy(['rm', 'file.bin', '--local'], { cwd: testDir });

      // Local file should be removed
      expect(existsSync(join(testDir, 'file.bin'))).toBe(false);

      // .bref should still exist
      expect(existsSync(join(testDir, 'file.bin.bref'))).toBe(true);

      // Backend blob should still exist
      const brefContent = await readFile(join(testDir, 'file.bin.bref'), 'utf-8');
      const bref = parseYaml(brefContent) as { remote_key?: string };
      const backendBlobPath = join(backendDir, bref.remote_key!);
      expect(existsSync(backendBlobPath)).toBe(true);
    });
  });
});

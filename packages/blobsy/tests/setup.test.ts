import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';

describe('setup command', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'blobsy-setup-test-'));

    // Initialize git repo
    await execa('git', ['init'], { cwd: testDir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    await execa('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should create .blobsy.yml via init', async () => {
    const backendDir = join(testDir, '..', 'setup-backend');
    try {
      const { stdout } = await execa('blobsy', ['setup', '--auto', 'local:../setup-backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      });

      expect(existsSync(join(testDir, '.blobsy.yml'))).toBe(true);
      expect(stdout).toContain('Initialized blobsy');
      expect(stdout).toContain('Setup complete!');
    } finally {
      await rm(backendDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should error without --auto flag', async () => {
    await expect(
      execa('blobsy', ['setup', 'local:../backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      }),
    ).rejects.toThrow(/--auto flag is required/);
  });

  it('should install .claude/skills/blobsy/SKILL.md when Claude detected', async () => {
    // Create .claude/ directory to simulate Claude Code presence
    await mkdir(join(testDir, '.claude'), { recursive: true });
    const backendDir = join(testDir, '..', 'setup-claude-backend');

    try {
      await execa('blobsy', ['setup', '--auto', 'local:../setup-claude-backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      });

      const skillPath = join(testDir, '.claude', 'skills', 'blobsy', 'SKILL.md');
      expect(existsSync(skillPath)).toBe(true);

      const content = await readFile(skillPath, 'utf-8');
      expect(content).toContain('# blobsy');
      expect(content).toContain('blobsy track');
      expect(content).toContain('status --json');
    } finally {
      await rm(backendDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should add blobsy section to existing AGENTS.md', async () => {
    // Create an existing AGENTS.md
    await writeFile(join(testDir, 'AGENTS.md'), '# Project Agents\n\nSome existing content.\n');
    const backendDir = join(testDir, '..', 'setup-agents-backend');

    try {
      await execa('blobsy', ['setup', '--auto', 'local:../setup-agents-backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      });

      const content = await readFile(join(testDir, 'AGENTS.md'), 'utf-8');
      expect(content).toContain('# Project Agents');
      expect(content).toContain('<!-- BEGIN BLOBSY INTEGRATION -->');
      expect(content).toContain('## Blobsy');
      expect(content).toContain('<!-- END BLOBSY INTEGRATION -->');
    } finally {
      await rm(backendDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should update AGENTS.md section idempotently', async () => {
    await writeFile(join(testDir, 'AGENTS.md'), '# Agents\n');
    const backendDir = join(testDir, '..', 'setup-idempotent-backend');

    try {
      // Run setup twice
      await execa('blobsy', ['setup', '--auto', 'local:../setup-idempotent-backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      });
      await execa('blobsy', ['setup', '--auto', 'local:../setup-idempotent-backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      });

      const content = await readFile(join(testDir, 'AGENTS.md'), 'utf-8');
      // Should only have one BEGIN marker
      const beginCount = content.split('<!-- BEGIN BLOBSY INTEGRATION -->').length - 1;
      expect(beginCount).toBe(1);
    } finally {
      await rm(backendDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should not create AGENTS.md if it does not exist', async () => {
    const backendDir = join(testDir, '..', 'setup-no-agents-backend');

    try {
      await execa('blobsy', ['setup', '--auto', 'local:../setup-no-agents-backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      });

      expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(false);
    } finally {
      await rm(backendDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });

  it('should update .claude/skills/blobsy/SKILL.md idempotently', async () => {
    // Create .claude/ directory to simulate Claude Code presence
    const skillDir = join(testDir, '.claude', 'skills', 'blobsy');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), 'old content');
    const backendDir = join(testDir, '..', 'setup-skill-update-backend');

    try {
      await execa('blobsy', ['setup', '--auto', 'local:../setup-skill-update-backend'], {
        cwd: testDir,
        env: { ...process.env, BLOBSY_NO_HOOKS: '1' },
      });

      const content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8');
      // Should be updated to latest content, not 'old content'
      expect(content).toContain('# blobsy');
      expect(content).not.toBe('old content');
    } finally {
      await rm(backendDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  });
});

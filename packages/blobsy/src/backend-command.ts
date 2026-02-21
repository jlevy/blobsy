/**
 * Command template backend.
 *
 * Execute arbitrary shell commands for push/pull with template variable
 * expansion. Used by echo backend test fixture and custom backends.
 */

import { execSync } from 'node:child_process';
import { rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Backend } from './types.js';
import { BlobsyError, ValidationError } from './types.js';
import { computeHash } from './hash.js';

export interface CommandTemplateVars {
  local: string;
  remote: string;
  relative_path: string;
  bucket: string;
}

export interface CommandBackendConfig {
  pushCommand?: string;
  pullCommand?: string;
  existsCommand?: string;
  bucket?: string;
}

/** Shell-escape a string by wrapping in single quotes. */
function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Expand template variables in a command string with shell escaping. */
export function expandCommandTemplate(template: string, vars: CommandTemplateVars): string {
  return template
    .replace(/\{local\}/g, shellEscape(vars.local))
    .replace(/\{remote\}/g, shellEscape(vars.remote))
    .replace(/\{relative_path\}/g, shellEscape(vars.relative_path))
    .replace(/\{bucket\}/g, shellEscape(vars.bucket));
}

export class CommandBackend implements Backend {
  readonly type = 'command' as const;
  private readonly config: CommandBackendConfig;

  constructor(config: CommandBackendConfig) {
    this.config = config;
  }

  push(localPath: string, remoteKey: string): Promise<void> {
    if (!this.config.pushCommand) {
      throw new ValidationError('No push_command configured for command backend.');
    }
    const vars: CommandTemplateVars = {
      local: resolve(localPath),
      remote: `${this.config.bucket ?? ''}/${remoteKey}`,
      relative_path: '',
      bucket: this.config.bucket ?? '',
    };
    commandPush(this.config.pushCommand, vars);
    return Promise.resolve();
  }

  async pull(remoteKey: string, localPath: string, expectedHash?: string): Promise<void> {
    if (!this.config.pullCommand) {
      throw new ValidationError('No pull_command configured for command backend.');
    }
    const tmpSuffix = randomBytes(8).toString('hex');
    const tempPath = `${localPath}.blobsy-cmd-${tmpSuffix}`;
    const vars: CommandTemplateVars = {
      local: resolve(tempPath),
      remote: `${this.config.bucket ?? ''}/${remoteKey}`,
      relative_path: '',
      bucket: this.config.bucket ?? '',
    };
    commandPull(this.config.pullCommand, vars, tempPath);

    if (expectedHash) {
      const actualHash = await computeHash(tempPath);
      if (actualHash !== expectedHash) {
        await unlink(tempPath);
        throw new BlobsyError(
          `Hash mismatch on pull: expected ${expectedHash}, got ${actualHash}`,
          'validation',
        );
      }
    }

    await rename(tempPath, localPath);
  }

  exists(remoteKey: string): Promise<boolean> {
    if (!this.config.existsCommand) {
      return Promise.resolve(false);
    }
    const vars: CommandTemplateVars = {
      local: '',
      remote: `${this.config.bucket ?? ''}/${remoteKey}`,
      relative_path: '',
      bucket: this.config.bucket ?? '',
    };
    return Promise.resolve(commandBlobExists(this.config.existsCommand, vars));
  }

  async healthCheck(): Promise<void> {
    // No health check for command backends -- commands are user-defined
  }
}

/** Execute a push command. */
export function commandPush(pushCommand: string, vars: CommandTemplateVars): void {
  const cmd = expandCommandTemplate(pushCommand, vars);
  executeCommand(cmd, 'push');
}

/** Execute a pull command. Pull to a temp path, caller handles rename. */
export function commandPull(
  pullCommand: string,
  vars: CommandTemplateVars,
  tempOutPath: string,
): void {
  const cmd = expandCommandTemplate(pullCommand, vars);
  executeCommand(cmd, 'pull', { BLOBSY_TEMP_OUT: tempOutPath });
}

/** Execute an exists check command. Returns true if exit code is 0. */
export function commandBlobExists(existsCommand: string, vars: CommandTemplateVars): boolean {
  const cmd = expandCommandTemplate(existsCommand, vars);
  try {
    execSync(cmd, {
      shell: '/bin/sh',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return true;
  } catch (err) {
    const execError = err as { status?: number | null; signal?: string | null; stderr?: Buffer };
    if (execError.status != null && execError.signal == null) {
      return false;
    }
    const stderr = execError.stderr?.toString().trim() ?? '';
    throw new BlobsyError(
      `Exists check command failed unexpectedly: ${cmd}\n${stderr}`,
      categorizeCommandError(stderr),
    );
  }
}

function executeCommand(cmd: string, operation: string, extraEnv?: Record<string, string>): void {
  try {
    execSync(cmd, {
      shell: '/bin/sh',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      env: { ...process.env, ...extraEnv },
    });
  } catch (err) {
    const execError = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    const exitCode = execError.status ?? 1;
    const stderr = execError.stderr?.toString().trim() ?? '';
    const stdout = execError.stdout?.toString().trim() ?? '';

    const details = [stdout, stderr].filter(Boolean).join('\n');
    throw new BlobsyError(
      `Command ${operation} failed (exit ${exitCode}): ${cmd}\n${details}`,
      categorizeCommandError(stderr),
      1,
    );
  }
}

export function categorizeCommandError(stderr: string): BlobsyError['category'] {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('access denied') ||
    lower.includes('forbidden') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    return 'authentication';
  }
  if (lower.includes('not found') || lower.includes('404') || lower.includes('no such')) {
    return 'not_found';
  }
  if (lower.includes('network') || lower.includes('connection') || lower.includes('timeout')) {
    return 'network';
  }
  if (lower.includes('permission') || lower.includes('denied')) {
    return 'permission';
  }
  if (lower.includes('quota') || lower.includes('limit')) {
    return 'quota';
  }
  if (lower.includes('disk full') || lower.includes('no space')) {
    return 'storage_full';
  }
  return 'unknown';
}

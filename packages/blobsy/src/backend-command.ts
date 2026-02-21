/**
 * Command template backend.
 *
 * Execute arbitrary shell commands for push/pull with template variable
 * expansion. Used by echo backend test fixture and custom backends.
 */

import { execSync } from 'node:child_process';

import { BlobsyError } from './types.js';

export interface CommandTemplateVars {
  local: string;
  remote: string;
  relative_path: string;
  bucket: string;
}

/** Expand template variables in a command string. */
export function expandCommandTemplate(template: string, vars: CommandTemplateVars): string {
  return template
    .replace(/\{local\}/g, vars.local)
    .replace(/\{remote\}/g, vars.remote)
    .replace(/\{relative_path\}/g, vars.relative_path)
    .replace(/\{bucket\}/g, vars.bucket);
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
  } catch {
    return false;
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

function categorizeCommandError(stderr: string): BlobsyError['category'] {
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

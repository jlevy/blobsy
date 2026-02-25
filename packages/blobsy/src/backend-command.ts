/**
 * Command template backend.
 *
 * Executes user-configured commands for push/pull/exists. Template variables
 * ({local}, {remote}, etc.) and environment variables ($VAR) are expanded
 * per-token, validated against a safe character allowlist, then executed via
 * execFileSync — bypassing the shell entirely to prevent injection.
 */

import { execFileSync } from 'node:child_process';
import { rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Backend } from './types.js';
import { BlobsyError, ValidationError } from './types.js';
import { computeHash } from './hash.js';

/** Timeout for exists check commands (shorter than push/pull) */
const EXISTS_CHECK_TIMEOUT_MS = 30000;

/** Timeout for push/pull commands */
const TRANSFER_COMMAND_TIMEOUT_MS = 60000;

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

/**
 * Allowed characters in fully expanded command tokens.
 *
 * Permits: alphanumeric, space, and common path/URL characters.
 * Rejects: shell metacharacters, quotes, backslashes, control characters.
 */
const SAFE_TOKEN_PATTERN = /^[-a-zA-Z0-9 /_.+=:@~,%#]*$/;

const KNOWN_TEMPLATE_VARS: ReadonlySet<string> = new Set([
  'local',
  'remote',
  'relative_path',
  'bucket',
]);

/**
 * Parse a command template into argv tokens, expand variables, and validate.
 *
 * 1. Split template on whitespace into tokens
 * 2. Expand blobsy template variables (`{name}`) per token
 * 3. Expand environment variables (`$NAME` or `${NAME}`) per token
 * 4. Validate each expanded token against a safe character allowlist
 *
 * The result is passed to `execFileSync` as pre-parsed arguments,
 * bypassing the shell entirely to prevent injection.
 */
export function parseAndExpandCommand(template: string, vars: CommandTemplateVars): string[] {
  const tokens = template.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new ValidationError('Command template is empty.');
  }

  return tokens.map((token, i) => {
    let expanded = token;

    // 1. Expand blobsy template variables (skip ${...} which are env vars)
    expanded = expanded.replace(/(?<!\$)\{(\w+)\}/g, (_match, key: string) => {
      if (!KNOWN_TEMPLATE_VARS.has(key)) {
        throw new ValidationError(`Unknown template variable {${key}} in command template.`, [
          'Known variables: {local}, {remote}, {relative_path}, {bucket}',
        ]);
      }
      return vars[key as keyof CommandTemplateVars];
    });

    // 2. Expand environment variables ($NAME or ${NAME})
    expanded = expanded.replace(
      /\$\{(\w+)\}|\$(\w+)/g,
      (_match, braced: string | undefined, bare: string | undefined) => {
        const name = (braced ?? bare)!;
        const value = process.env[name];
        if (value === undefined) {
          throw new ValidationError(
            `Undefined environment variable $${name} in command template.`,
            ['Set the variable or remove it from the template.'],
          );
        }
        return value;
      },
    );

    // 3. Validate the fully expanded token
    validateExpandedToken(expanded, i === 0 ? 'command' : `argument ${i}`);

    return expanded;
  });
}

function validateExpandedToken(token: string, context: string): void {
  if (!SAFE_TOKEN_PATTERN.test(token)) {
    const unsafeChars = [...new Set([...token].filter((c) => !SAFE_TOKEN_PATTERN.test(c)))];
    throw new ValidationError(
      `Unsafe characters in expanded command ${context}: ${JSON.stringify(token)}`,
      [
        `Disallowed characters: ${unsafeChars.map((c) => JSON.stringify(c)).join(', ')}`,
        'Allowed: alphanumeric, space, and / _ - . + = : @ ~ , % #',
      ],
    );
  }
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

  delete(_remoteKey: string): Promise<void> {
    // Command backends don't support delete operation
    return Promise.reject(new Error('Delete operation not supported for command backends'));
  }

  healthCheck(): Promise<void> {
    // Check that at least one command is configured
    if (!this.config.pushCommand && !this.config.pullCommand) {
      throw new ValidationError('Command backend has no push or pull commands configured.');
    }
    // Verify the command binary exists in PATH
    const command = this.config.pushCommand ?? this.config.pullCommand!;
    const binary = command.split(/\s+/)[0];
    if (!binary) {
      throw new ValidationError('Command template is empty.');
    }
    try {
      execFileSync('which', [binary], { stdio: 'pipe' });
    } catch {
      throw new BlobsyError(
        `Command not found: ${binary}. Ensure it is installed and in your PATH.`,
        'not_found',
      );
    }
    return Promise.resolve();
  }
}

/** Execute a push command. */
export function commandPush(pushCommand: string, vars: CommandTemplateVars): void {
  const args = parseAndExpandCommand(pushCommand, vars);
  executeCommandDirect(args, 'push');
}

/** Execute a pull command. Pull to a temp path, caller handles rename. */
export function commandPull(
  pullCommand: string,
  vars: CommandTemplateVars,
  tempOutPath: string,
): void {
  const args = parseAndExpandCommand(pullCommand, vars);
  executeCommandDirect(args, 'pull', { BLOBSY_TEMP_OUT: tempOutPath });
}

/** Execute an exists check command. Returns true if exit code is 0. */
export function commandBlobExists(existsCommand: string, vars: CommandTemplateVars): boolean {
  const args = parseAndExpandCommand(existsCommand, vars);
  const [command, ...cmdArgs] = args;
  if (!command) {
    throw new ValidationError('Exists command template produced no command.');
  }
  try {
    execFileSync(command, cmdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: EXISTS_CHECK_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    const execError = err as {
      status?: number | null;
      signal?: string | null;
      stderr?: Buffer;
      code?: string;
    };
    if (execError.status != null && execError.signal == null) {
      return false;
    }
    if (execError.code === 'ENOENT') {
      throw new BlobsyError(
        `Command not found: ${command}. Ensure it is installed and in your PATH.`,
        'not_found',
      );
    }
    const stderr = execError.stderr?.toString().trim() ?? '';
    throw new BlobsyError(
      `Exists check command failed unexpectedly: ${args.join(' ')}\n${stderr}`,
      categorizeCommandError(stderr),
    );
  }
}

function executeCommandDirect(
  args: string[],
  operation: string,
  extraEnv?: Record<string, string>,
): void {
  const [command, ...cmdArgs] = args;
  if (!command) {
    throw new ValidationError('Command template produced no command.');
  }
  try {
    execFileSync(command, cmdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TRANSFER_COMMAND_TIMEOUT_MS,
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
    });
  } catch (err) {
    const execError = err as {
      status?: number;
      stdout?: Buffer;
      stderr?: Buffer;
      code?: string;
    };
    if (execError.code === 'ENOENT') {
      throw new BlobsyError(
        `Command not found: ${command}. Ensure it is installed and in your PATH.`,
        'not_found',
      );
    }
    const exitCode = execError.status ?? 1;
    const stderr = execError.stderr?.toString().trim() ?? '';
    const stdout = execError.stdout?.toString().trim() ?? '';

    const cmdStr = args.join(' ');
    const details = [stdout, stderr].filter(Boolean).join('\n');
    throw new BlobsyError(
      `Command ${operation} failed (exit ${exitCode}): ${cmdStr}\n${details}`,
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

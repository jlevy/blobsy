#!/usr/bin/env node

/**
 * CLI entry point for blobsy.
 *
 * Commander.js-based CLI with all subcommands, global flags, and
 * dual-mode output (human-readable + JSON).
 */

import { existsSync, statSync } from 'node:fs';
import { readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import type { Help } from 'commander';
import { Command, Option } from 'commander';

import { parseBackendUrl, validateBackendUrl, resolveLocalPath } from './backend-url.js';
import { getConfigPath, getExternalizeConfig, resolveConfig, writeConfigFile } from './config.js';
import { shouldExternalize } from './externalize.js';
import {
  formatDryRun,
  formatError,
  formatJson,
  formatJsonDryRun,
  formatJsonError,
  formatJsonMessage,
  formatSize,
} from './format.js';
import { ensureDir } from './fs-utils.js';
import { addGitignoreEntry, removeGitignoreEntry } from './gitignore.js';
import { computeHash } from './hash.js';
import {
  findRepoRoot,
  findBrefFiles,
  findTrackableFiles,
  isDirectory,
  normalizePath,
  resolveFilePath,
  stripBrefExtension,
  toRepoRelative,
  brefPath,
} from './paths.js';
import { readBref, writeBref } from './ref.js';
import {
  getGlobalOpts,
  handlePush,
  handlePull,
  handleSync,
  handleHealth,
  handleDoctor,
  handleHooks,
  handleCheckUnpushed,
  handlePrePushCheck,
  handleHook,
  resolveTrackedFiles,
} from './commands-stage2.js';
import { createCacheEntry, getStatCacheDir, writeCacheEntry } from './stat-cache.js';
import { PRIME_TEXT, SKILL_BRIEF, SKILL_FULL } from './skill-text.js';
import type { BlobsyConfig, GlobalOptions, Bref } from './types.js';
import {
  BlobsyError,
  FILE_STATE_SYMBOLS,
  BREF_FORMAT,
  ValidationError,
  UserError,
} from './types.js';

function createProgram(): Command {
  const program = new Command();

  program
    .name('blobsy')
    .description('Store large files anywhere. Track them in Git.')
    .version(getVersion(), '--version', 'Show version number')
    .helpOption('-h, --help', 'Display help for command')
    .addOption(new Option('--json', 'Structured JSON output').hideHelp(false).preset(true))
    .addOption(
      new Option('--quiet', 'Suppress all output except errors').hideHelp(false).preset(true),
    )
    .addOption(new Option('--verbose', 'Detailed progress output').hideHelp(false).preset(true))
    .addOption(
      new Option('--dry-run', 'Show what would happen without doing it')
        .hideHelp(false)
        .preset(true),
    )
    .configureHelp({
      helpWidth: 80,
      showGlobalOptions: false,
      formatHelp: (cmd: Command, helper: Help) => {
        const termWidth = 25;
        const lines: string[] = [];

        // Usage
        lines.push(`Usage: ${helper.commandUsage(cmd)}`);
        lines.push('');

        // Description
        const desc = helper.commandDescription(cmd);
        if (desc) {
          lines.push(desc);
          lines.push('');
        }

        // Arguments
        const args = helper.visibleArguments(cmd);
        if (args.length > 0) {
          lines.push('Arguments:');
          for (const arg of args) {
            const term = `  ${arg.name()}`;
            const desc = arg.description;
            lines.push(term.padEnd(termWidth) + desc);
          }
          lines.push('');
        }

        // Options
        const opts = helper.visibleOptions(cmd);
        if (opts.length > 0) {
          lines.push('Options:');
          for (const opt of opts) {
            const flags = opt.flags;
            const desc = opt.description;
            const term = `  ${flags}`;
            lines.push(term.padEnd(termWidth) + desc);
          }
          lines.push('');
        }

        // Commands
        const cmds = helper.visibleCommands(cmd);
        if (cmds.length > 0) {
          lines.push('Commands:');
          for (const sub of cmds) {
            const name = sub.name();
            const argParts = sub.registeredArguments.map((a) => {
              const suffix = a.variadic ? '...' : '';
              return a.required ? `<${a.name()}${suffix}>` : `[${a.name()}${suffix}]`;
            });
            const argsStr = argParts.join(' ');
            const term = `  ${name}${argsStr ? ' ' + argsStr : ''}`;
            const desc = name === 'help' ? 'Display help for command' : sub.description();
            lines.push(term.padEnd(termWidth) + desc);
          }
          lines.push('');
        }

        // Epilog
        if (cmd.name() === 'blobsy') {
          lines.push('Get started:');
          lines.push('  blobsy init s3://bucket/prefix/');
          lines.push('  blobsy track <file>');
          lines.push('  blobsy push');
          lines.push('');
          lines.push('Docs: https://github.com/jlevy/blobsy');
          lines.push('');
        }

        return lines.join('\n');
      },
    });

  program
    .command('init')
    .description('Initialize blobsy in a git repo with a backend URL')
    .argument('<url>', 'Backend URL (e.g. s3://bucket/prefix/, local:../path)')
    .option('--region <region>', 'AWS region (for S3 backends)')
    .option('--endpoint <endpoint>', 'Custom S3-compatible endpoint URL')
    .action(wrapAction(handleInit));

  program
    .command('track')
    .description('Start tracking files or directories with .bref pointers')
    .argument('<path...>', 'Files or directories to track')
    .option('--force', 'Skip confirmation for destructive operations')
    .action(wrapAction(handleTrack));

  program
    .command('untrack')
    .description('Stop tracking files (keeps local files, moves .bref to trash)')
    .argument('<path...>', 'Files or directories to untrack')
    .option('--recursive', 'Required for directory removal')
    .action(wrapAction(handleUntrack));

  program
    .command('rm')
    .description('Remove tracked files: delete local + move .bref to trash')
    .argument('<path...>', 'Files or directories to remove')
    .option('--local', 'Delete local file only, keep .bref and remote')
    .option('--remote', 'Also delete blob from backend (requires confirmation)')
    .option('--force', 'Skip confirmation prompts')
    .option('--recursive', 'Required for directory removal')
    .action(wrapAction(handleRm));

  program
    .command('mv')
    .description('Rename or move tracked files or directories (updates .bref + .gitignore)')
    .argument('<source>', 'Source tracked file or directory')
    .argument('<dest>', 'Destination path')
    .action(wrapAction(handleMv));

  program
    .command('push')
    .description('Upload local blobs to the configured backend')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--force', 'Re-push even if remote exists')
    .action(wrapAction(handlePush));

  program
    .command('pull')
    .description('Download blobs from the configured backend')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--force', 'Overwrite local modifications')
    .action(wrapAction(handlePull));

  program
    .command('sync')
    .description('Bidirectional sync: push unpushed + pull missing')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--skip-health-check', 'Skip backend health check')
    .option('--force', 'Force sync (overwrite conflicts)')
    .action(wrapAction(handleSync));

  program
    .command('status')
    .description('Show sync state of tracked files')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--json', 'Structured JSON output')
    .action(wrapAction(handleStatus));

  program
    .command('verify')
    .description('Verify local files match their .bref hashes')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--json', 'Structured JSON output')
    .action(wrapAction(handleVerify));

  program
    .command('config')
    .description('Show, get, or set .blobsy.yml values')
    .argument('[key]', 'Config key (dot-separated, e.g. compress.algorithm)')
    .argument('[value]', 'Value to set')
    .action(wrapAction(handleConfig));

  program
    .command('health')
    .description('Test backend connectivity and permissions')
    .action(wrapAction(handleHealth));

  program
    .command('doctor')
    .description('Run diagnostics and optionally auto-fix issues')
    .option('--fix', 'Attempt to automatically fix detected issues')
    .option('--json', 'Structured JSON output')
    .option('--verbose', 'Show detailed diagnostic logs')
    .action(wrapAction(handleDoctor));

  program
    .command('hooks')
    .description('Install or uninstall the blobsy pre-commit hook')
    .argument('<action>', 'install or uninstall')
    .action(wrapAction(handleHooks));

  program
    .command('check-unpushed')
    .description('List committed .bref files whose blobs are not yet pushed')
    .action(wrapAction(handleCheckUnpushed));

  program
    .command('pre-push-check')
    .description('CI guard: fail if any .bref is missing its remote blob')
    .action(wrapAction(handlePrePushCheck));

  program
    .command('hook', { hidden: true })
    .description('Internal hook commands')
    .argument('<type>', 'Hook type (pre-commit)')
    .action(wrapAction(handleHook));

  program
    .command('skill')
    .description('Output blobsy skill documentation (for AI agents)')
    .option('--brief', 'Short summary only')
    .action(
      // eslint-disable-next-line @typescript-eslint/require-await
      wrapAction(async (opts: Record<string, unknown>) => {
        console.log(opts.brief ? SKILL_BRIEF : SKILL_FULL);
      }),
    );

  program
    .command('prime')
    .description('Output context primer for AI agents working in this repo')
    .option('--brief', 'Short summary only')
    .action(
      // eslint-disable-next-line @typescript-eslint/require-await
      wrapAction(async (opts: Record<string, unknown>) => {
        console.log(opts.brief ? SKILL_BRIEF : PRIME_TEXT);
      }),
    );

  return program;
}

function getVersion(): string {
  return '0.1.0';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionHandler = (...args: any[]) => Promise<void>;

/**
 * Wrap a command action with error handling and JSON output.
 */
function wrapAction(handler: ActionHandler): ActionHandler {
  return async (...args: unknown[]) => {
    try {
      const cmd = args.find((a) => a instanceof Command);
      if (cmd) {
        const g = getGlobalOpts(cmd);
        if (g.quiet && g.verbose) {
          throw new ValidationError('--quiet and --verbose cannot be used together.');
        }
      }
      await handler(...args);
    } catch (err) {
      const cmd = args.find((a) => a instanceof Command);
      const globalOpts = cmd
        ? getGlobalOpts(cmd)
        : { json: false, quiet: false, verbose: false, dryRun: false };

      if (err instanceof UserError) {
        // User-friendly errors with hints
        if (globalOpts.json) {
          console.error(formatJsonError(err));
        } else {
          console.error(err.format());
        }
        process.exitCode = err.exitCode;
      } else if (err instanceof BlobsyError) {
        if (globalOpts.json) {
          console.error(formatJsonError(err));
        } else {
          console.error(formatError(err));
        }
        process.exitCode = err.exitCode;
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        if (globalOpts.json) {
          console.error(formatJsonError(error));
        } else {
          console.error(`Error: ${error.message}`);
        }
        process.exitCode = 1;
      }
    }
  };
}

// --- Command Handlers ---

async function handleInit(url: string, opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const configPath = getConfigPath(repoRoot);

  const parsed = parseBackendUrl(url);
  validateBackendUrl(parsed, repoRoot);

  // Auto-create local backend directory if it doesn't exist
  if (parsed.type === 'local' && parsed.path) {
    const absPath = resolveLocalPath(parsed.path, repoRoot);

    if (!existsSync(absPath)) {
      try {
        // Create backend directory (with all parent directories if needed)
        await ensureDir(absPath);

        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(
            `Created backend directory: ${normalizePath(toRepoRelative(absPath, repoRoot))}`,
          );
        }
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        const parentDir = dirname(absPath);

        if (error.code === 'ENOENT') {
          // This shouldn't happen with recursive: true, but just in case
          throw new ValidationError(
            `Cannot create backend directory: ${absPath}\n` +
              `  Parent directory does not exist: ${parentDir}\n` +
              `  Create parent first: mkdir -p ${parentDir}`,
          );
        }

        if (error.code === 'EACCES') {
          throw new ValidationError(
            `Permission denied creating backend directory: ${absPath}\n` +
              `  Check directory permissions`,
          );
        }

        throw error; // Re-throw unexpected errors
      }
    }
  }

  if (globalOpts.dryRun) {
    const actions = [];
    if (!existsSync(configPath)) {
      actions.push(`create ${normalizePath(toRepoRelative(configPath, repoRoot))}`);
    }
    actions.push('install pre-commit hook');
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const a of actions) {
        console.log(formatDryRun(a));
      }
    }
    return;
  }

  if (existsSync(configPath)) {
    if (!globalOpts.quiet) {
      const msg = `Config already exists at ${normalizePath(toRepoRelative(configPath, repoRoot))}. Skipping config creation.`;
      if (globalOpts.json) {
        console.log(formatJsonMessage(msg));
      } else {
        console.log(msg);
      }
    }
  } else {
    const config: Record<string, unknown> = {
      backends: {
        default: {
          url,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        },
      },
    };

    await writeConfigFile(configPath, config);

    if (!globalOpts.quiet) {
      const msg = `Initialized blobsy in ${normalizePath(toRepoRelative(repoRoot, repoRoot)) || '.'}`;
      if (globalOpts.json) {
        console.log(formatJsonMessage(msg));
      } else {
        console.log(msg);
        console.log(`Created ${normalizePath(toRepoRelative(configPath, repoRoot))}`);
      }
    }
  }

  // Install stub pre-commit hook
  await installStubHook(repoRoot, globalOpts);
}

async function installStubHook(repoRoot: string, globalOpts: GlobalOptions): Promise<void> {
  const hookDir = join(repoRoot, '.git', 'hooks');
  const hookPath = join(hookDir, 'pre-commit');

  // Skip if BLOBSY_NO_HOOKS is set (for testing)
  if (process.env.BLOBSY_NO_HOOKS) {
    return;
  }

  // Check for hook managers
  if (existsSync(join(repoRoot, 'lefthook.yml')) || existsSync(join(repoRoot, '.husky'))) {
    if (!globalOpts.quiet && !globalOpts.json) {
      console.log('Hook manager detected. Add blobsy to your hook configuration.');
    }
    return;
  }

  if (existsSync(hookPath)) {
    const content = await readFile(hookPath, 'utf-8');
    if (!content.includes('blobsy')) {
      if (!globalOpts.quiet && !globalOpts.json) {
        console.log('Existing pre-commit hook found. Add blobsy manually.');
      }
      return;
    }
  }

  await ensureDir(hookDir);
  const { writeFile: writeFs, chmod } = await import('node:fs/promises');
  const hookContent = `#!/bin/sh
# Installed by: blobsy hooks install
# To bypass: git commit --no-verify
exec blobsy hook pre-commit
`;
  await writeFs(hookPath, hookContent);
  await chmod(hookPath, 0o755);

  if (!globalOpts.quiet && !globalOpts.json) {
    console.log('Installed pre-commit hook.');
  }
}

async function handleTrack(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const cacheDir = getStatCacheDir(repoRoot);
  const config = await resolveConfig(repoRoot, repoRoot);

  for (const inputPath of paths) {
    const absPath = resolveFilePath(stripBrefExtension(inputPath));

    if (isDirectory(absPath)) {
      await trackDirectory(absPath, repoRoot, cacheDir, config, globalOpts);
    } else {
      await trackSingleFile(absPath, repoRoot, cacheDir, globalOpts);
    }
  }
}

async function trackSingleFile(
  absPath: string,
  repoRoot: string,
  cacheDir: string,
  globalOpts: GlobalOptions,
): Promise<void> {
  const relPath = toRepoRelative(absPath, repoRoot);
  const refPath = brefPath(absPath);
  const refRelPath = toRepoRelative(refPath, repoRoot);
  const fileDir = dirname(absPath);
  const fileName = basename(absPath);

  if (!existsSync(absPath)) {
    throw new ValidationError(`File not found: ${relPath}`, ['Check the file path and try again.']);
  }

  if (globalOpts.dryRun) {
    const action = existsSync(refPath) ? `update ${refRelPath}` : `track ${relPath}`;
    if (globalOpts.json) {
      console.log(formatJsonDryRun([action]));
    } else {
      console.log(formatDryRun(action));
    }
    return;
  }

  const hash = await computeHash(absPath);
  const fileStat = statSync(absPath);
  const fileSize = fileStat.size;

  // Check for existing ref
  if (existsSync(refPath)) {
    const existingRef = await readBref(refPath);
    if (existingRef.hash === hash) {
      if (!globalOpts.quiet) {
        if (globalOpts.json) {
          console.log(formatJsonMessage(`${relPath} already tracked (unchanged)`));
        } else {
          console.log(`${relPath} already tracked (unchanged)`);
        }
      }
      return;
    }

    // Hash changed, update. Clear remote_key since old key points to old content.
    const newRef: Bref = {
      ...existingRef,
      hash,
      size: fileSize,
      remote_key: undefined,
      compressed: undefined,
      compressed_size: undefined,
    };
    await writeBref(refPath, newRef);

    // Update stat cache
    const entry = await createCacheEntry(absPath, relPath, hash);
    await writeCacheEntry(cacheDir, entry);

    if (!globalOpts.quiet) {
      if (globalOpts.json) {
        console.log(formatJsonMessage(`Updated ${refRelPath} (hash changed)`));
      } else {
        console.log(`Updated ${refRelPath} (hash changed)`);
      }
    }
    return;
  }

  // New tracking
  const ref: Bref = {
    format: BREF_FORMAT,
    hash,
    size: fileSize,
  };
  await writeBref(refPath, ref);

  // Add to gitignore
  await addGitignoreEntry(fileDir, fileName);

  // Write stat cache
  const entry = await createCacheEntry(absPath, relPath, hash);
  await writeCacheEntry(cacheDir, entry);

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Tracking ${relPath}`));
    } else {
      console.log(`Tracking ${relPath}`);
      console.log(`Created ${refRelPath}`);
      console.log(`Added ${relPath} to .gitignore`);
    }
  }
}

async function trackDirectory(
  absDir: string,
  repoRoot: string,
  cacheDir: string,
  config: BlobsyConfig,
  globalOpts: GlobalOptions,
): Promise<void> {
  const relDir = toRepoRelative(absDir, repoRoot);
  const files = findTrackableFiles(absDir);
  const extConfig = getExternalizeConfig(config);

  if (globalOpts.dryRun) {
    const trackable = files.filter((f) => {
      const rel = toRepoRelative(f, repoRoot);
      const sz = statSync(f).size;
      return shouldExternalize(rel, sz, extConfig);
    });
    if (globalOpts.json) {
      console.log(formatJsonDryRun(trackable.map((f) => `track ${toRepoRelative(f, repoRoot)}`)));
    } else {
      console.log(
        formatDryRun(
          `track ${trackable.length} file${trackable.length === 1 ? '' : 's'} in ${relDir}/`,
        ),
      );
    }
    return;
  }

  if (!globalOpts.quiet && !globalOpts.json) {
    console.log(`Scanning ${relDir}/...`);
  }

  let tracked = 0;
  let unchanged = 0;

  for (const absFilePath of files) {
    const relFilePath = toRepoRelative(absFilePath, repoRoot);
    const fileStat = statSync(absFilePath);
    const fileSize = fileStat.size;

    if (!shouldExternalize(relFilePath, fileSize, extConfig)) {
      continue;
    }

    const refPath = brefPath(absFilePath);
    const hash = await computeHash(absFilePath);
    const fileName = basename(absFilePath);
    const fileDir = dirname(absFilePath);
    const sizeStr = formatSize(fileSize).padStart(6);

    if (existsSync(refPath)) {
      const existingRef = await readBref(refPath);
      if (existingRef.hash === hash) {
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(
            `  ${relFilePath}${' '.repeat(Math.max(1, 22 - relFilePath.length))}(${sizeStr})  -> already tracked (unchanged)`,
          );
        }
        unchanged++;
        continue;
      }

      const newRef: Bref = { ...existingRef, hash, size: fileSize };
      await writeBref(refPath, newRef);
      const entry = await createCacheEntry(absFilePath, relFilePath, hash);
      await writeCacheEntry(cacheDir, entry);

      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(
          `  ${relFilePath}${' '.repeat(Math.max(1, 22 - relFilePath.length))}(${sizeStr})  -> updated (hash changed)`,
        );
      }
      tracked++;
    } else {
      const ref: Bref = { format: BREF_FORMAT, hash, size: fileSize };
      await writeBref(refPath, ref);
      await addGitignoreEntry(fileDir, fileName);
      const entry = await createCacheEntry(absFilePath, relFilePath, hash);
      await writeCacheEntry(cacheDir, entry);

      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(
          `  ${relFilePath}${' '.repeat(Math.max(1, 22 - relFilePath.length))}(${sizeStr})  -> tracked`,
        );
      }
      tracked++;
    }
  }

  if (!globalOpts.quiet && !globalOpts.json) {
    const parts: string[] = [];
    if (tracked > 0) {
      parts.push(`${tracked} file${tracked === 1 ? '' : 's'} tracked`);
    } else {
      parts.push('0 files tracked');
    }
    if (unchanged > 0) {
      parts.push(`${unchanged} unchanged`);
    }
    console.log(`${parts.join(', ')}.`);
  }
}

async function handleStatus(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const useJson = Boolean(opts.json) || globalOpts.json;
  const repoRoot = findRepoRoot();

  const files = resolveTrackedFiles(paths, repoRoot);

  if (files.length === 0) {
    if (useJson) {
      console.log(formatJson({ files: [], summary: { total: 0 } }));
    } else {
      console.log('No tracked files found.');
    }
    return;
  }

  const results: {
    path: string;
    symbol: string;
    state: string;
    details: string;
  }[] = [];

  for (const file of files) {
    const { symbol, state, details } = await getFileState(file.absPath, file.refPath, file.relPath);
    results.push({ path: file.relPath, symbol, state, details });
  }

  if (useJson) {
    console.log(
      formatJson({
        files: results.map((r) => ({
          path: r.path,
          state: r.state,
          details: r.details,
        })),
        summary: {
          total: results.length,
        },
      }),
    );
  } else {
    for (const r of results) {
      console.log(`  ${r.symbol}  ${r.path}  ${r.details}`);
    }
    console.log('');
    console.log(`${results.length} tracked file${results.length === 1 ? '' : 's'}`);
  }
}

async function getFileState(
  absPath: string,
  refPath: string,
  _relPath: string,
): Promise<{ symbol: string; state: string; details: string }> {
  if (!existsSync(refPath)) {
    return { symbol: FILE_STATE_SYMBOLS.missing, state: 'missing_ref', details: '.bref not found' };
  }

  const ref = await readBref(refPath);

  if (!existsSync(absPath)) {
    return { symbol: FILE_STATE_SYMBOLS.missing, state: 'missing_file', details: 'file missing' };
  }

  const currentHash = await computeHash(absPath);

  if (currentHash !== ref.hash) {
    return { symbol: FILE_STATE_SYMBOLS.modified, state: 'modified', details: 'modified' };
  }

  if (ref.remote_key) {
    // Check if .bref is committed (simplified: check if in git)
    return { symbol: FILE_STATE_SYMBOLS.synced, state: 'synced', details: 'synced' };
  }

  // No remote_key: not pushed yet
  // Simplified check: if .bref is committed
  return { symbol: FILE_STATE_SYMBOLS.new, state: 'new', details: 'not pushed' };
}

async function handleVerify(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const useJson = Boolean(opts.json) || globalOpts.json;
  const repoRoot = findRepoRoot();

  const files = resolveTrackedFiles(paths, repoRoot);

  let hasIssues = false;
  const results: { path: string; status: string; expected?: string; actual?: string }[] = [];

  for (const file of files) {
    if (!existsSync(file.refPath)) {
      results.push({ path: file.relPath, status: 'missing_ref' });
      hasIssues = true;
      continue;
    }

    const ref = await readBref(file.refPath);

    if (!existsSync(file.absPath)) {
      results.push({ path: file.relPath, status: 'missing' });
      hasIssues = true;
      continue;
    }

    const currentHash = await computeHash(file.absPath);
    if (currentHash !== ref.hash) {
      results.push({
        path: file.relPath,
        status: 'mismatch',
        expected: ref.hash,
        actual: currentHash,
      });
      hasIssues = true;
    } else {
      results.push({ path: file.relPath, status: 'ok' });
    }
  }

  if (useJson) {
    console.log(formatJson({ files: results, ok: !hasIssues }));
  } else {
    for (const r of results) {
      const statusStr = r.status === 'ok' ? 'ok' : r.status;
      console.log(`  ${r.status === 'ok' ? '\u2713' : '\u2717'}  ${r.path}  ${statusStr}`);
    }
    if (hasIssues) {
      console.log('');
      console.log('Verification failed.');
    } else {
      console.log('');
      console.log('All files verified.');
    }
  }

  if (hasIssues) {
    process.exitCode = 1;
  }
}

async function handleUntrack(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const recursive = Boolean(opts.recursive);
  const repoRoot = findRepoRoot();

  for (const inputPath of paths) {
    const absPath = resolveFilePath(stripBrefExtension(inputPath));

    if (isDirectory(absPath)) {
      if (!recursive) {
        throw new ValidationError(
          `${toRepoRelative(absPath, repoRoot)} is a directory. Use --recursive to untrack all files in it.`,
        );
      }
      const brefFiles = findBrefFiles(absPath, repoRoot);
      for (const rel of brefFiles) {
        await untrackFile(join(repoRoot, rel), repoRoot, globalOpts);
      }
    } else {
      await untrackFile(absPath, repoRoot, globalOpts);
    }
  }
}

async function untrackFile(
  absPath: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
): Promise<void> {
  const relPath = toRepoRelative(absPath, repoRoot);
  const refPath = brefPath(absPath);
  const fileName = basename(absPath);
  const fileDir = dirname(absPath);

  if (!existsSync(refPath)) {
    throw new ValidationError(`Not tracked: ${relPath} (no .bref file found)`);
  }

  if (globalOpts.dryRun) {
    if (globalOpts.json) {
      console.log(formatJsonDryRun([`untrack ${relPath}`]));
    } else {
      console.log(formatDryRun(`untrack ${relPath}`));
    }
    return;
  }

  // Move .bref to trash
  const trashDir = join(repoRoot, '.blobsy', 'trash');
  await ensureDir(trashDir);
  const trashPath = join(trashDir, `${basename(refPath)}.${Date.now()}`);
  await rename(refPath, trashPath);

  // Remove from gitignore
  await removeGitignoreEntry(fileDir, fileName);

  // Clean stat cache
  const cacheDir = getStatCacheDir(repoRoot);
  const { deleteCacheEntry } = await import('./stat-cache.js');
  await deleteCacheEntry(cacheDir, relPath);

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Untracked ${relPath}`));
    } else {
      console.log(`Untracked ${relPath}`);
      console.log(`Moved ${toRepoRelative(refPath, repoRoot)} to trash`);
    }
  }
}

async function handleRm(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const localOnly = Boolean(opts.local);
  const deleteRemote = Boolean(opts.remote);
  const force = Boolean(opts.force);
  const recursive = Boolean(opts.recursive);
  const repoRoot = findRepoRoot();

  // Validate flag combinations
  if (localOnly && deleteRemote) {
    throw new ValidationError('Cannot use both --local and --remote flags');
  }

  for (const inputPath of paths) {
    const absPath = resolveFilePath(stripBrefExtension(inputPath));

    if (isDirectory(absPath)) {
      if (!recursive) {
        throw new ValidationError(
          `${toRepoRelative(absPath, repoRoot)} is a directory. Use --recursive to remove all files in it.`,
        );
      }
      const brefFiles = findBrefFiles(absPath, repoRoot);
      for (const rel of brefFiles) {
        await rmFile(join(repoRoot, rel), repoRoot, localOnly, deleteRemote, force, globalOpts);
      }
    } else {
      await rmFile(absPath, repoRoot, localOnly, deleteRemote, force, globalOpts);
    }
  }
}

async function rmFile(
  absPath: string,
  repoRoot: string,
  localOnly: boolean,
  deleteRemote: boolean,
  force: boolean,
  globalOpts: GlobalOptions,
): Promise<void> {
  const relPath = toRepoRelative(absPath, repoRoot);
  const refPath = brefPath(absPath);
  const fileName = basename(absPath);
  const fileDir = dirname(absPath);

  if (globalOpts.dryRun) {
    const action = localOnly ? `delete local file ${relPath}` : `remove ${relPath}`;
    if (globalOpts.json) {
      console.log(formatJsonDryRun([action]));
    } else {
      console.log(formatDryRun(action));
    }
    return;
  }

  if (localOnly) {
    // Just delete local file, keep .bref
    if (existsSync(absPath)) {
      await unlink(absPath);
    }
    if (!globalOpts.quiet) {
      if (globalOpts.json) {
        console.log(formatJsonMessage(`Deleted local file: ${relPath}`));
      } else {
        console.log(`Deleted local file: ${relPath}`);
      }
    }
    return;
  }

  if (!existsSync(refPath)) {
    throw new ValidationError(`Not tracked: ${relPath} (no .bref file found)`);
  }

  // Move .bref to trash
  const trashDir = join(repoRoot, '.blobsy', 'trash');
  await ensureDir(trashDir);
  const trashPath = join(trashDir, `${basename(refPath)}.${Date.now()}`);
  await rename(refPath, trashPath);

  // Delete from backend if --remote flag set
  if (deleteRemote) {
    const bref = await readBref(trashPath); // Read from trash copy

    if (bref.remote_key) {
      // Confirmation prompt (unless --force)
      if (!force && !globalOpts.quiet) {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await rl.question(
          `Delete blob from backend?\n` +
            `  File: ${relPath}\n` +
            `  Remote key: ${bref.remote_key}\n` +
            `  This cannot be undone. Continue? (y/N): `,
        );

        rl.close();

        if (answer.toLowerCase() !== 'y') {
          if (!globalOpts.quiet) {
            console.log(
              'Remote deletion cancelled. Local file and .bref removed, remote blob kept.',
            );
          }
          // Still continue with local cleanup below
          deleteRemote = false; // Skip backend deletion
        }
      }

      // Delete from backend if confirmed or --force
      if (deleteRemote) {
        try {
          const config = await resolveConfig(repoRoot, repoRoot);
          const { createBackend, resolveBackend } = await import('./transfer.js');
          if (!config.backends) {
            throw new ValidationError('No backend configured');
          }
          const resolvedBackend = resolveBackend(config);
          const backend = createBackend(resolvedBackend, repoRoot, config.sync?.tools);
          await backend.delete(bref.remote_key);

          if (!globalOpts.quiet) {
            if (globalOpts.json) {
              console.log(formatJsonMessage(`Deleted from backend: ${bref.remote_key}`));
            } else {
              console.log(`Deleted from backend: ${bref.remote_key}`);
            }
          }
        } catch (err: unknown) {
          // Don't fail the whole rm operation if backend deletion fails
          // Local cleanup already succeeded
          console.warn(
            `Warning: Failed to delete from backend: ${(err as Error).message}\n` +
              `  Remote blob may still exist: ${bref.remote_key}`,
          );
        }
      }
    } else if (!globalOpts.quiet) {
      console.log(`Note: File was never pushed (no remote_key), skipping backend deletion`);
    }
  }

  // Remove from gitignore
  await removeGitignoreEntry(fileDir, fileName);

  // Delete local file
  if (existsSync(absPath)) {
    await unlink(absPath);
  }

  // Clean stat cache
  const cacheDir = getStatCacheDir(repoRoot);
  const { deleteCacheEntry } = await import('./stat-cache.js');
  await deleteCacheEntry(cacheDir, relPath);

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Removed ${relPath}`));
    } else {
      console.log(`Removed ${relPath}`);
      console.log(`Moved ${toRepoRelative(refPath, repoRoot)} to trash`);
      console.log(`Deleted local file`);
    }
  }
}

async function handleMv(
  source: string,
  dest: string,
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();

  const srcAbs = resolveFilePath(stripBrefExtension(source));
  const destAbs = resolveFilePath(stripBrefExtension(dest));

  if (isDirectory(srcAbs)) {
    await handleMvDirectory(srcAbs, destAbs, repoRoot, globalOpts);
    return;
  }

  const srcRel = toRepoRelative(srcAbs, repoRoot);

  const srcRefPath = brefPath(srcAbs);
  if (!existsSync(srcRefPath)) {
    throw new ValidationError(`Not tracked: ${srcRel} (no .bref file found)`);
  }

  await mvSingleFile(srcAbs, destAbs, repoRoot, globalOpts);
}

async function handleMvDirectory(
  srcDir: string,
  destDir: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
): Promise<void> {
  const brefFiles = findBrefFiles(srcDir, repoRoot);
  if (brefFiles.length === 0) {
    throw new ValidationError(`No tracked files in ${toRepoRelative(srcDir, repoRoot)}`);
  }

  if (globalOpts.dryRun) {
    const actions = brefFiles.map((rel) => {
      const filePath = rel.replace(/\.bref$/, '');
      const relFromSrc = relative(toRepoRelative(srcDir, repoRoot), filePath);
      const destPath = join(toRepoRelative(destDir, repoRoot), relFromSrc);
      return `move ${filePath} -> ${destPath}`;
    });
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const action of actions) {
        console.log(formatDryRun(action));
      }
    }
    return;
  }

  for (const relBref of brefFiles) {
    const filePath = relBref.replace(/\.bref$/, '');
    const srcFileAbs = join(repoRoot, filePath);
    const relFromSrc = relative(toRepoRelative(srcDir, repoRoot), filePath);
    const destFileAbs = join(destDir, relFromSrc);

    await mvSingleFile(srcFileAbs, destFileAbs, repoRoot, globalOpts);
  }
}

async function mvSingleFile(
  srcAbs: string,
  destAbs: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
): Promise<void> {
  const srcRel = toRepoRelative(srcAbs, repoRoot);
  const destRel = toRepoRelative(destAbs, repoRoot);

  const srcRefPath = brefPath(srcAbs);
  const destRefPath = brefPath(destAbs);

  if (globalOpts.dryRun) {
    if (globalOpts.json) {
      console.log(formatJsonDryRun([`move ${srcRel} -> ${destRel}`]));
    } else {
      console.log(formatDryRun(`move ${srcRel} -> ${destRel}`));
    }
    return;
  }

  const ref = await readBref(srcRefPath);

  if (existsSync(srcAbs)) {
    await ensureDir(dirname(destAbs));
    await rename(srcAbs, destAbs);
  }

  await ensureDir(dirname(destRefPath));
  await writeBref(destRefPath, ref);
  await unlink(srcRefPath);

  await removeGitignoreEntry(dirname(srcAbs), basename(srcAbs));
  await addGitignoreEntry(dirname(destAbs), basename(destAbs));

  const cacheDir = getStatCacheDir(repoRoot);
  const { deleteCacheEntry } = await import('./stat-cache.js');
  await deleteCacheEntry(cacheDir, srcRel);
  if (existsSync(destAbs)) {
    const entry = await createCacheEntry(destAbs, destRel, ref.hash);
    await writeCacheEntry(cacheDir, entry);
  }

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Moved ${srcRel} -> ${destRel}`));
    } else {
      console.log(`Moved ${srcRel} -> ${destRel}`);
    }
  }
}

async function handleConfig(
  key: string | undefined,
  value: string | undefined,
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const configPath = getConfigPath(repoRoot);

  if (!key) {
    // Show all config
    if (!existsSync(configPath)) {
      if (globalOpts.json) {
        console.log(formatJson({ config: {} }));
      } else {
        console.log('No .blobsy.yml found. Run blobsy init first.');
      }
      return;
    }

    const content = await readFile(configPath, 'utf-8');
    if (globalOpts.json) {
      const config = await resolveConfig(repoRoot, repoRoot);
      console.log(formatJson({ config: config as unknown as Record<string, unknown> }));
    } else {
      console.log(content.trimEnd());
    }
    return;
  }

  if (!value) {
    // Get a specific key
    const config = await resolveConfig(repoRoot, repoRoot);
    const val = getNestedValue(config, key);
    if (globalOpts.json) {
      console.log(formatJson({ key, value: val }));
    } else {
      if (val === undefined) {
        console.log(`(not set)`);
      } else if (typeof val === 'object') {
        const { stringify } = await import('yaml');
        console.log(stringify(val).trimEnd());
      } else {
        console.log(`${val as string | number | boolean}`);
      }
    }
    return;
  }

  // Set a value -- simple key=value at the top level of the config
  if (!existsSync(configPath)) {
    throw new ValidationError('No .blobsy.yml found. Run blobsy init first.');
  }

  if (globalOpts.dryRun) {
    if (globalOpts.json) {
      console.log(formatJsonDryRun([`set ${key} = ${value}`]));
    } else {
      console.log(formatDryRun(`set ${key} = ${value}`));
    }
    return;
  }

  const { parse: parseYaml, stringify: stringifyYaml } = await import('yaml');
  const content = await readFile(configPath, 'utf-8');
  const config = (parseYaml(content) as Record<string, unknown>) ?? {};
  setNestedValue(config, key, value);
  const { writeFile: writeFs } = await import('node:fs/promises');
  await writeFs(configPath, stringifyYaml(config, { lineWidth: 0 }));

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Set ${key} = ${value}`));
    } else {
      console.log(`Set ${key} = ${value}`);
    }
  }
}

function getNestedValue(obj: object, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function coerceConfigValue(value: string): string | number | boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim().length > 0) {
    return num;
  }
  return value;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = coerceConfigValue(value);
}

// --- Main ---

export async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof BlobsyError) {
    console.error(formatError(err));
    process.exitCode = err.exitCode;
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
});

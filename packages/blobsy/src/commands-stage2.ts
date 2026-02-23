/**
 * Stage 2 command handlers: push, pull, sync, health, doctor, hooks,
 * check-unpushed, pre-push-check, hook.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute } from 'node:path';

import type { Command } from 'commander';

import { getConfigPath, resolveConfig } from './config.js';
import { ensureDir } from './fs-utils.js';
import { addGitignoreEntry } from './gitignore.js';
import { computeHash } from './hash.js';
import {
  findRepoRoot,
  findBrefFiles,
  isDirectory,
  resolveFilePath,
  stripBrefExtension,
  toRepoRelative,
  brefPath,
} from './paths.js';
import { readBref, writeBref } from './ref.js';
import { createCacheEntry, getStatCacheDir, writeCacheEntry } from './stat-cache.js';
import { pushFile, pullFile, blobExists, runHealthCheck } from './transfer.js';
import {
  formatDryRun,
  formatJson,
  formatJsonDryRun,
  formatJsonError,
  formatSize,
} from './format.js';
import type { GlobalOptions, TransferResult } from './types.js';
import { ValidationError, BREF_EXTENSION } from './types.js';

export function getGlobalOpts(cmd: Command): GlobalOptions {
  const root = cmd.parent ?? cmd;
  const opts = root.opts();
  return {
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
    verbose: Boolean(opts.verbose),
    dryRun: Boolean(opts.dryRun),
  };
}

export function resolveTrackedFiles(
  paths: string[],
  repoRoot: string,
): { relPath: string; absPath: string; refPath: string }[] {
  const targetPaths =
    paths.length > 0 ? paths.map((p) => resolveFilePath(stripBrefExtension(p))) : [repoRoot];

  const files: { relPath: string; absPath: string; refPath: string }[] = [];
  for (const tp of targetPaths) {
    if (isDirectory(tp)) {
      const brefFiles = findBrefFiles(tp, repoRoot);
      for (const rel of brefFiles) {
        files.push({
          relPath: rel,
          absPath: join(repoRoot, rel),
          refPath: join(repoRoot, brefPath(rel)),
        });
      }
    } else {
      const rel = toRepoRelative(tp, repoRoot);
      files.push({
        relPath: rel,
        absPath: tp,
        refPath: join(repoRoot, brefPath(rel)),
      });
    }
  }

  return files;
}

export async function handlePush(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const config = await resolveConfig(repoRoot, repoRoot);
  const cacheDir = getStatCacheDir(repoRoot);

  const files = resolveTrackedFiles(paths, repoRoot);

  if (files.length === 0) {
    if (globalOpts.json) {
      console.log(formatJson({ pushed: [], summary: { total: 0 } }));
    } else {
      console.log('No tracked files to push.');
    }
    return;
  }

  if (globalOpts.dryRun) {
    const needsPush = [];
    for (const file of files) {
      const ref = await readBref(file.refPath);
      if (!ref.remote_key || opts.force) {
        needsPush.push(`push ${file.relPath}`);
      }
    }
    if (globalOpts.json) {
      console.log(formatJsonDryRun(needsPush));
    } else {
      for (const a of needsPush) {
        console.log(formatDryRun(a));
      }
      console.log(
        `${formatDryRun(`push ${needsPush.length} file${needsPush.length === 1 ? '' : 's'}`)}`,
      );
    }
    return;
  }

  const results: TransferResult[] = [];

  for (const file of files) {
    const ref = await readBref(file.refPath);

    if (ref.remote_key && !opts.force) {
      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(`  ${file.relPath}  already pushed`);
      }
      continue;
    }

    if (opts.force && existsSync(file.absPath)) {
      const currentHash = await computeHash(file.absPath);
      if (currentHash !== ref.hash) {
        ref.hash = currentHash;
        ref.size = statSync(file.absPath).size;
      }
    }

    const result = await pushFile(file.absPath, file.relPath, ref, config, repoRoot);

    if (result.success && result.refUpdates) {
      const updatedRef = { ...ref, ...result.refUpdates };
      await writeBref(file.refPath, updatedRef);
      if (existsSync(file.absPath)) {
        const entry = await createCacheEntry(file.absPath, file.relPath, updatedRef.hash);
        await writeCacheEntry(cacheDir, entry);
      }
    }

    results.push(result);
  }

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (globalOpts.json) {
    console.log(
      formatJson({
        pushed: results,
        summary: { total: results.length, succeeded: succeeded.length, failed: failed.length },
      }),
    );
  } else if (!globalOpts.quiet) {
    for (const r of succeeded) {
      const sizeStr = r.bytesTransferred != null ? ` (${formatSize(r.bytesTransferred)})` : '';
      console.log(`  ${r.path}${sizeStr} - pushed`);
    }
    for (const r of failed) {
      console.error(`  ${r.path} - FAILED: ${r.error}`);
    }
    console.log(
      `Done: ${succeeded.length} pushed${failed.length > 0 ? `, ${failed.length} failed` : ''}.`,
    );
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

export async function handlePull(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const config = await resolveConfig(repoRoot, repoRoot);
  const cacheDir = getStatCacheDir(repoRoot);

  const files = resolveTrackedFiles(paths, repoRoot);

  if (files.length === 0) {
    if (globalOpts.json) {
      console.log(formatJson({ pulled: [], summary: { total: 0 } }));
    } else {
      console.log('No tracked files to pull.');
    }
    return;
  }

  if (globalOpts.dryRun) {
    const needsPull = [];
    for (const file of files) {
      const ref = await readBref(file.refPath);
      if (ref.remote_key) {
        needsPull.push(`pull ${file.relPath}`);
      }
    }
    if (globalOpts.json) {
      console.log(formatJsonDryRun(needsPull));
    } else {
      for (const a of needsPull) {
        console.log(formatDryRun(a));
      }
      console.log(
        formatDryRun(`pull ${needsPull.length} file${needsPull.length === 1 ? '' : 's'}`),
      );
    }
    return;
  }

  const results: TransferResult[] = [];

  for (const file of files) {
    const ref = await readBref(file.refPath);

    if (!ref.remote_key) {
      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(`  ${file.relPath}  not pushed yet (no remote_key)`);
      }
      continue;
    }

    if (!opts.force && existsSync(file.absPath)) {
      const currentHash = await computeHash(file.absPath);
      if (currentHash === ref.hash) {
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(`  ${file.relPath}  already up to date`);
        }
        continue;
      }
    }

    const result = await pullFile(ref, file.absPath, config, repoRoot);

    if (result.success) {
      const entry = await createCacheEntry(file.absPath, file.relPath, ref.hash);
      await writeCacheEntry(cacheDir, entry);
    }

    results.push(result);
  }

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (globalOpts.json) {
    console.log(
      formatJson({
        pulled: results,
        summary: { total: results.length, succeeded: succeeded.length, failed: failed.length },
      }),
    );
  } else if (!globalOpts.quiet) {
    for (const r of succeeded) {
      const sizeStr = r.bytesTransferred != null ? ` (${formatSize(r.bytesTransferred)})` : '';
      console.log(`  ${r.path}${sizeStr} - pulled`);
    }
    for (const r of failed) {
      console.error(`  ${r.path} - FAILED: ${r.error}`);
    }
    console.log(
      `Done: ${succeeded.length} pulled${failed.length > 0 ? `, ${failed.length} failed` : ''}.`,
    );
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

export async function handleSync(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const config = await resolveConfig(repoRoot, repoRoot);
  const cacheDir = getStatCacheDir(repoRoot);

  if (!opts.skipHealthCheck) {
    try {
      await runHealthCheck(config, repoRoot);
    } catch (err) {
      if (globalOpts.json) {
        console.error(formatJsonError(err instanceof Error ? err : new Error(String(err))));
      } else {
        console.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exitCode = 1;
      return;
    }
  }

  const files = resolveTrackedFiles(paths, repoRoot);

  if (globalOpts.dryRun) {
    const actions = [];
    for (const file of files) {
      const ref = await readBref(file.refPath);
      if (!ref.remote_key) {
        actions.push(`push ${file.relPath}`);
      } else if (!existsSync(file.absPath)) {
        actions.push(`pull ${file.relPath}`);
      }
    }
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const a of actions) {
        console.log(formatDryRun(a));
      }
      if (actions.length === 0) {
        console.log('Everything up to date.');
      }
    }
    return;
  }

  let pushed = 0;
  let pulled = 0;
  let errors = 0;

  for (const file of files) {
    const ref = await readBref(file.refPath);

    if (!ref.remote_key) {
      const result = await pushFile(file.absPath, file.relPath, ref, config, repoRoot);
      if (result.success && result.refUpdates) {
        const updatedRef = { ...ref, ...result.refUpdates };
        await writeBref(file.refPath, updatedRef);
        if (existsSync(file.absPath)) {
          const entry = await createCacheEntry(file.absPath, file.relPath, updatedRef.hash);
          await writeCacheEntry(cacheDir, entry);
        }
        pushed++;
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(`  \u2191 ${file.relPath} - pushed`);
        }
      } else {
        errors++;
        if (!globalOpts.quiet) {
          console.error(`  \u2717 ${file.relPath} - push failed: ${result.error}`);
        }
      }
    } else if (!existsSync(file.absPath)) {
      const result = await pullFile(ref, file.absPath, config, repoRoot);
      if (result.success) {
        const entry = await createCacheEntry(file.absPath, file.relPath, ref.hash);
        await writeCacheEntry(cacheDir, entry);
        pulled++;
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(`  \u2193 ${file.relPath} - pulled`);
        }
      } else {
        errors++;
        if (!globalOpts.quiet) {
          console.error(`  \u2717 ${file.relPath} - pull failed: ${result.error}`);
        }
      }
    } else {
      const currentHash = await computeHash(file.absPath);
      if (currentHash !== ref.hash) {
        const modifiedRef = {
          ...ref,
          hash: currentHash,
          size: statSync(file.absPath).size,
          remote_key: undefined,
        };
        const result = await pushFile(file.absPath, file.relPath, modifiedRef, config, repoRoot);
        if (result.success && result.refUpdates) {
          const updatedRef = { ...modifiedRef, ...result.refUpdates };
          await writeBref(file.refPath, updatedRef);
          const entry = await createCacheEntry(file.absPath, file.relPath, updatedRef.hash);
          await writeCacheEntry(cacheDir, entry);
          pushed++;
          if (!globalOpts.quiet && !globalOpts.json) {
            console.log(`  \u2191 ${file.relPath} - pushed (modified)`);
          }
        } else {
          errors++;
        }
      } else if (!globalOpts.quiet && !globalOpts.json) {
        console.log(`  \u2713 ${file.relPath} - up to date`);
      }
    }
  }

  if (globalOpts.json) {
    console.log(formatJson({ sync: { pushed, pulled, errors, total: files.length } }));
  } else if (!globalOpts.quiet) {
    console.log(`Sync complete: ${pushed} pushed, ${pulled} pulled, ${errors} errors.`);
  }

  if (errors > 0) {
    process.exitCode = 1;
  }
}

export async function handleHealth(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const config = await resolveConfig(repoRoot, repoRoot);

  try {
    await runHealthCheck(config, repoRoot);
    if (globalOpts.json) {
      console.log(formatJson({ status: 'ok', message: 'Backend is reachable and writable.' }));
    } else {
      console.log('Backend is reachable and writable.');
    }
  } catch (err) {
    if (globalOpts.json) {
      console.error(formatJsonError(err instanceof Error ? err : new Error(String(err))));
    } else {
      console.error(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

export async function handleDoctor(opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const useJson = Boolean(opts.json) || globalOpts.json;
  const fix = Boolean(opts.fix);
  const repoRoot = findRepoRoot();

  if (globalOpts.dryRun && fix) {
    if (useJson) {
      console.log(formatJsonDryRun(['run doctor diagnostics', 'fix detected issues']));
    } else {
      console.log(formatDryRun('run doctor diagnostics and fix detected issues'));
    }
    return;
  }
  const config = await resolveConfig(repoRoot, repoRoot);

  const issues: { type: string; message: string; fixed: boolean }[] = [];

  const configPath = getConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    issues.push({ type: 'config', message: 'No .blobsy.yml found', fixed: false });
  }

  const blobsyDir = join(repoRoot, '.blobsy');
  if (!existsSync(blobsyDir)) {
    if (fix) {
      await ensureDir(blobsyDir);
      issues.push({ type: 'directory', message: 'Created .blobsy/ directory', fixed: true });
    } else {
      issues.push({ type: 'directory', message: '.blobsy/ directory missing', fixed: false });
    }
  }

  const allBrefs = findBrefFiles(repoRoot, repoRoot);
  for (const relPath of allBrefs) {
    const absPath = join(repoRoot, relPath);
    const refPath = join(repoRoot, brefPath(relPath));

    if (!existsSync(absPath) && existsSync(refPath)) {
      const ref = await readBref(refPath);
      if (!ref.remote_key) {
        issues.push({
          type: 'orphan',
          message: `${relPath}: .bref exists but local file missing and no remote_key`,
          fixed: false,
        });
      }
    }
  }

  for (const relPath of allBrefs) {
    const absPath = join(repoRoot, relPath);
    const fileName = basename(absPath);
    const fileDir = dirname(absPath);
    const gitignorePath = join(fileDir, '.gitignore');

    if (existsSync(join(repoRoot, brefPath(relPath)))) {
      const { readBlobsyBlock } = await import('./gitignore.js');
      const entries = await readBlobsyBlock(gitignorePath);
      if (!entries.includes(fileName)) {
        if (fix) {
          await addGitignoreEntry(fileDir, fileName);
          issues.push({
            type: 'gitignore',
            message: `${relPath}: added missing .gitignore entry`,
            fixed: true,
          });
        } else {
          issues.push({
            type: 'gitignore',
            message: `${relPath}: missing from .gitignore`,
            fixed: false,
          });
        }
      }
    }
  }

  try {
    await runHealthCheck(config, repoRoot);
  } catch (err) {
    issues.push({
      type: 'backend',
      message: `Backend health check failed: ${err instanceof Error ? err.message : String(err)}`,
      fixed: false,
    });
  }

  if (useJson) {
    console.log(
      formatJson({
        issues,
        summary: {
          total: issues.length,
          fixed: issues.filter((i) => i.fixed).length,
          unfixed: issues.filter((i) => !i.fixed).length,
        },
      }),
    );
  } else {
    if (issues.length === 0) {
      console.log('No issues found.');
    } else {
      for (const issue of issues) {
        const prefix = issue.fixed ? '\u2713 Fixed' : '\u2717';
        console.log(`  ${prefix}  ${issue.message}`);
      }
      console.log('');
      const unfixed = issues.filter((i) => !i.fixed).length;
      if (unfixed > 0) {
        console.log(
          `${unfixed} issue${unfixed === 1 ? '' : 's'} found.${!fix ? ' Run with --fix to attempt repairs.' : ''}`,
        );
      } else {
        console.log('All issues fixed.');
      }
    }
  }

  if (issues.some((i) => !i.fixed)) {
    process.exitCode = 1;
  }
}

const HOOK_TYPES = [
  { name: 'pre-commit', gitEvent: 'pre-commit', bypassCmd: 'git commit --no-verify' },
  { name: 'pre-push', gitEvent: 'pre-push', bypassCmd: 'git push --no-verify' },
] as const;

export async function handleHooks(
  action: string,
  _opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();

  if (globalOpts.dryRun) {
    const actions = HOOK_TYPES.map((h) => `${action} ${h.name} hook`);
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const a of actions) {
        console.log(formatDryRun(a));
      }
    }
    return;
  }

  if (action === 'install') {
    const hookDir = join(repoRoot, '.git', 'hooks');
    await ensureDir(hookDir);
    const { writeFile: writeFs, chmod } = await import('node:fs/promises');

    // Detect absolute path to blobsy executable
    let blobsyPath: string;

    // Option 1: Use process.argv[1] (current executable)
    const execPath = process.argv[1];

    if (execPath && isAbsolute(execPath)) {
      blobsyPath = execPath;
    } else {
      // Option 2: Try to find blobsy in PATH
      try {
        const result = execFileSync('which', ['blobsy'], { encoding: 'utf-8' });
        blobsyPath = result.trim();
      } catch {
        // Fallback: use 'blobsy' and warn user
        blobsyPath = 'blobsy';

        if (!globalOpts.quiet) {
          console.warn(
            '⚠️  Warning: Could not detect absolute path to blobsy executable.\n' +
              '   Hook will use "blobsy" from PATH.\n' +
              '   To ensure hooks work, install blobsy globally: pnpm link --global',
          );
        }
      }
    }

    for (const hook of HOOK_TYPES) {
      const hookPath = join(hookDir, hook.name);
      const hookContent = `#!/bin/sh
# Installed by: blobsy hooks install
# To bypass: ${hook.bypassCmd}
exec "${blobsyPath}" hook ${hook.gitEvent}
`;
      await writeFs(hookPath, hookContent);
      await chmod(hookPath, 0o755);

      if (!globalOpts.quiet) {
        console.log(`Installed ${hook.name} hook.`);
      }
    }

    if (!globalOpts.quiet && blobsyPath !== 'blobsy') {
      console.log(`  Using executable: ${blobsyPath}`);
    }
  } else if (action === 'uninstall') {
    for (const hook of HOOK_TYPES) {
      const hookPath = join(repoRoot, '.git', 'hooks', hook.name);
      if (existsSync(hookPath)) {
        const content = await readFile(hookPath, 'utf-8');
        if (content.includes('blobsy')) {
          await unlink(hookPath);
          if (!globalOpts.quiet) {
            console.log(`Uninstalled ${hook.name} hook.`);
          }
        } else if (!globalOpts.quiet) {
          console.log(
            `${hook.name.charAt(0).toUpperCase() + hook.name.slice(1)} hook not managed by blobsy.`,
          );
        }
      } else if (!globalOpts.quiet) {
        console.log(`No ${hook.name} hook found.`);
      }
    }
  } else {
    throw new ValidationError(`Unknown hooks action: ${action}. Use 'install' or 'uninstall'.`);
  }
}

export async function handleCheckUnpushed(
  _opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();

  const allBrefs = findBrefFiles(repoRoot, repoRoot);
  const unpushed: string[] = [];

  for (const relPath of allBrefs) {
    const refPath = join(repoRoot, brefPath(relPath));
    const ref = await readBref(refPath);
    if (!ref.remote_key) {
      unpushed.push(relPath);
    }
  }

  if (globalOpts.json) {
    console.log(formatJson({ unpushed, count: unpushed.length }));
  } else {
    if (unpushed.length === 0) {
      console.log('All tracked files have been pushed.');
    } else {
      for (const path of unpushed) {
        console.log(`  ${path}`);
      }
      console.log(`\n${unpushed.length} file${unpushed.length === 1 ? '' : 's'} not pushed.`);
    }
  }

  if (unpushed.length > 0) {
    process.exitCode = 1;
  }
}

export async function handlePrePushCheck(
  _opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const config = await resolveConfig(repoRoot, repoRoot);

  const allBrefs = findBrefFiles(repoRoot, repoRoot);
  const missing: string[] = [];

  for (const relPath of allBrefs) {
    const refPath = join(repoRoot, brefPath(relPath));
    const ref = await readBref(refPath);

    if (!ref.remote_key) {
      missing.push(relPath);
      continue;
    }

    const exists = await blobExists(ref.remote_key, config, repoRoot);
    if (!exists) {
      missing.push(relPath);
    }
  }

  if (globalOpts.json) {
    console.log(formatJson({ missing, count: missing.length, ok: missing.length === 0 }));
  } else {
    if (missing.length === 0) {
      console.log('All refs have remote blobs. Safe to push.');
    } else {
      for (const path of missing) {
        console.log(`  ${path}  missing remote blob`);
      }
      console.log(
        `\n${missing.length} file${missing.length === 1 ? '' : 's'} missing remote blobs.`,
      );
      console.log('Run blobsy push first.');
    }
  }

  if (missing.length > 0) {
    process.exitCode = 1;
  }
}

async function handlePreCommitHook(repoRoot: string): Promise<void> {
  // Find staged .bref files
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  })
    .trim()
    .split('\n')
    .filter((f) => f.endsWith(BREF_EXTENSION));

  if (staged.length === 0) return;

  const failures: string[] = [];
  for (const brefRelPath of staged) {
    const brefAbsPath = join(repoRoot, brefRelPath);
    const ref = await readBref(brefAbsPath);
    const dataPath = stripBrefExtension(brefAbsPath);

    if (!existsSync(dataPath)) {
      // Data file missing is OK — it may have been gitignored and deleted
      continue;
    }

    const actualHash = await computeHash(dataPath);
    if (actualHash !== ref.hash) {
      failures.push(stripBrefExtension(brefRelPath));
    }
  }

  if (failures.length > 0) {
    console.error('blobsy pre-commit: hash mismatch detected.');
    console.error('The following files were modified after tracking:\n');
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    console.error('\nRe-run `blobsy track` (or `blobsy add`) to update the .bref files.');
    console.error('To bypass: git commit --no-verify');
    process.exitCode = 1;
  }
}

async function handlePrePushHook(repoRoot: string): Promise<void> {
  const config = await resolveConfig(repoRoot, repoRoot);
  const allBrefs = findBrefFiles(repoRoot, repoRoot);
  const unpushed: string[] = [];

  for (const relPath of allBrefs) {
    const refPath = join(repoRoot, brefPath(relPath));
    const ref = await readBref(refPath);
    if (!ref.remote_key) {
      unpushed.push(relPath);
    }
  }

  if (unpushed.length === 0) return;

  console.log(
    `blobsy pre-push: uploading ${unpushed.length} blob${unpushed.length === 1 ? '' : 's'}...`,
  );

  // Push each unpushed blob
  const cacheDir = getStatCacheDir(repoRoot);
  for (const relPath of unpushed) {
    const refPath = join(repoRoot, brefPath(relPath));
    const ref = await readBref(refPath);
    const absPath = join(repoRoot, relPath);

    const result = await pushFile(absPath, relPath, ref, config, repoRoot);

    if (result.success && result.refUpdates) {
      const updatedRef = { ...ref, ...result.refUpdates };
      await writeBref(refPath, updatedRef);
      if (existsSync(absPath)) {
        const entry = await createCacheEntry(absPath, relPath, updatedRef.hash);
        await writeCacheEntry(cacheDir, entry);
      }
    }
  }

  console.log('blobsy pre-push: all blobs uploaded.');
}

export async function handleHook(
  type: string,
  _opts: Record<string, unknown>,
  _cmd: Command,
): Promise<void> {
  if (process.env.BLOBSY_NO_HOOKS) return;

  const repoRoot = findRepoRoot();

  if (type === 'pre-commit') {
    await handlePreCommitHook(repoRoot);
  } else if (type === 'pre-push') {
    await handlePrePushHook(repoRoot);
  } else {
    throw new ValidationError(`Unknown hook type: ${type}`);
  }
}

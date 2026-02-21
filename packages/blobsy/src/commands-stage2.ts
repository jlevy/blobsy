/**
 * Stage 2 command handlers: push, pull, sync, health, doctor, hooks,
 * check-unpushed, pre-push-check, hook.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Command } from 'commander';

import { getConfigPath, resolveConfig } from './config.js';
import { ensureDir } from './fs-utils.js';
import { addGitignoreEntry } from './gitignore.js';
import { computeHash } from './hash.js';
import {
  findRepoRoot,
  findYrefFiles,
  isDirectory,
  resolveFilePath,
  stripYrefExtension,
  toRepoRelative,
  yrefPath,
} from './paths.js';
import { readYRef, writeYRef } from './ref.js';
import { createCacheEntry, getStatCacheDir, writeCacheEntry } from './stat-cache.js';
import { pushFile, pullFile, blobExists, runHealthCheck } from './transfer.js';
import { formatJson, formatJsonError, formatSize } from './format.js';
import type { GlobalOptions, TransferResult } from './types.js';
import { ValidationError } from './types.js';

export function getGlobalOpts(cmd: Command): GlobalOptions {
  const root = cmd.parent ?? cmd;
  const opts = root.opts();
  return {
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
    verbose: Boolean(opts.verbose),
  };
}

export function resolveTrackedFiles(
  paths: string[],
  repoRoot: string,
): { relPath: string; absPath: string; refPath: string }[] {
  const targetPaths =
    paths.length > 0 ? paths.map((p) => resolveFilePath(stripYrefExtension(p))) : [repoRoot];

  const files: { relPath: string; absPath: string; refPath: string }[] = [];
  for (const tp of targetPaths) {
    if (isDirectory(tp)) {
      const yrefFiles = findYrefFiles(tp, repoRoot);
      for (const rel of yrefFiles) {
        files.push({
          relPath: rel,
          absPath: join(repoRoot, rel),
          refPath: join(repoRoot, yrefPath(rel)),
        });
      }
    } else {
      const rel = toRepoRelative(tp, repoRoot);
      files.push({
        relPath: rel,
        absPath: tp,
        refPath: join(repoRoot, yrefPath(rel)),
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

  const results: TransferResult[] = [];

  for (const file of files) {
    const ref = await readYRef(file.refPath);

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
      await writeYRef(file.refPath, updatedRef);
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

  const results: TransferResult[] = [];

  for (const file of files) {
    const ref = await readYRef(file.refPath);

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
  let pushed = 0;
  let pulled = 0;
  let errors = 0;

  for (const file of files) {
    const ref = await readYRef(file.refPath);

    if (!ref.remote_key) {
      const result = await pushFile(file.absPath, file.relPath, ref, config, repoRoot);
      if (result.success && result.refUpdates) {
        const updatedRef = { ...ref, ...result.refUpdates };
        await writeYRef(file.refPath, updatedRef);
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
          await writeYRef(file.refPath, updatedRef);
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

  const allYrefs = findYrefFiles(repoRoot, repoRoot);
  for (const relPath of allYrefs) {
    const absPath = join(repoRoot, relPath);
    const refPath = join(repoRoot, yrefPath(relPath));

    if (!existsSync(absPath) && existsSync(refPath)) {
      const ref = await readYRef(refPath);
      if (!ref.remote_key) {
        issues.push({
          type: 'orphan',
          message: `${relPath}: .yref exists but local file missing and no remote_key`,
          fixed: false,
        });
      }
    }
  }

  for (const relPath of allYrefs) {
    const absPath = join(repoRoot, relPath);
    const fileName = basename(absPath);
    const fileDir = dirname(absPath);
    const gitignorePath = join(fileDir, '.gitignore');

    if (existsSync(join(repoRoot, yrefPath(relPath)))) {
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

export async function handleHooks(
  action: string,
  _opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const hookPath = join(repoRoot, '.git', 'hooks', 'pre-commit');

  if (action === 'install') {
    const hookDir = join(repoRoot, '.git', 'hooks');
    await ensureDir(hookDir);
    const { writeFile: writeFs, chmod } = await import('node:fs/promises');
    const hookContent = `#!/bin/sh\n# Installed by: blobsy hooks install\n# To bypass: git commit --no-verify\nexec blobsy hook pre-commit\n`;
    await writeFs(hookPath, hookContent);
    await chmod(hookPath, 0o755);
    if (!globalOpts.quiet) {
      console.log('Installed pre-commit hook.');
    }
  } else if (action === 'uninstall') {
    if (existsSync(hookPath)) {
      const content = await readFile(hookPath, 'utf-8');
      if (content.includes('blobsy')) {
        await unlink(hookPath);
        if (!globalOpts.quiet) {
          console.log('Uninstalled pre-commit hook.');
        }
      } else if (!globalOpts.quiet) {
        console.log('Pre-commit hook not managed by blobsy.');
      }
    } else if (!globalOpts.quiet) {
      console.log('No pre-commit hook found.');
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

  const allYrefs = findYrefFiles(repoRoot, repoRoot);
  const unpushed: string[] = [];

  for (const relPath of allYrefs) {
    const refPath = join(repoRoot, yrefPath(relPath));
    const ref = await readYRef(refPath);
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

  const allYrefs = findYrefFiles(repoRoot, repoRoot);
  const missing: string[] = [];

  for (const relPath of allYrefs) {
    const refPath = join(repoRoot, yrefPath(relPath));
    const ref = await readYRef(refPath);

    if (!ref.remote_key) {
      missing.push(relPath);
      continue;
    }

    const exists = blobExists(ref.remote_key, config, repoRoot);
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

// eslint-disable-next-line @typescript-eslint/require-await
export async function handleHook(
  type: string,
  _opts: Record<string, unknown>,
  _cmd: Command,
): Promise<void> {
  if (type === 'pre-commit') {
    return;
  }
  throw new ValidationError(`Unknown hook type: ${type}`);
}

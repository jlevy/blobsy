/**
 * Stage 2 command handlers: push, pull, sync, health, doctor, hooks,
 * check-unpushed, pre-push-check, hook.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join, isAbsolute } from 'node:path';

import type { Command } from 'commander';

import {
  getConfigPath,
  getGlobalConfigPath,
  loadConfigFile,
  parseSize,
  resolveConfig,
} from './config.js';
import { ensureDir } from './fs-utils.js';
import { addGitignoreEntry, readBlobsyBlock } from './gitignore.js';
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
import { pushFile, pullFile, blobExists, runHealthCheck, resolveBackend } from './transfer.js';
import { parseBackendUrl } from './backend-url.js';
import {
  formatCheckFail,
  formatCheckFixed,
  formatCheckPass,
  formatCheckWarn,
  formatCount,
  formatDryRun,
  formatFileState,
  formatHeading,
  formatJson,
  formatJsonDryRun,
  formatJsonError,
  formatPullResult,
  formatPushResult,
  formatTransferFail,
  formatWarning,
  OUTPUT_SYMBOLS,
} from './format.js';
import type {
  BlobsyConfig,
  DoctorIssue,
  FileStateSymbol,
  GlobalOptions,
  TransferResult,
} from './types.js';
import { ValidationError, BREF_EXTENSION, FILE_STATE_SYMBOLS } from './types.js';

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

export interface FileStateResult {
  path: string;
  symbol: string;
  state: string;
  details: string;
  size?: number | undefined;
}

async function getFileState(
  absPath: string,
  refPath: string,
): Promise<{ symbol: string; state: string; details: string; size?: number | undefined }> {
  if (!existsSync(refPath)) {
    return { symbol: FILE_STATE_SYMBOLS.missing, state: 'missing_ref', details: '.bref not found' };
  }

  const ref = await readBref(refPath);

  if (!existsSync(absPath)) {
    return {
      symbol: FILE_STATE_SYMBOLS.missing,
      state: 'missing_file',
      details: 'file missing',
      size: ref.size,
    };
  }

  const currentHash = await computeHash(absPath);

  if (currentHash !== ref.hash) {
    return {
      symbol: FILE_STATE_SYMBOLS.modified,
      state: 'modified',
      details: 'modified',
      size: ref.size,
    };
  }

  if (ref.remote_key) {
    return {
      symbol: FILE_STATE_SYMBOLS.synced,
      state: 'synced',
      details: 'synced',
      size: ref.size,
    };
  }

  return { symbol: FILE_STATE_SYMBOLS.new, state: 'new', details: 'not pushed', size: ref.size };
}

export async function computeFileStates(
  files: { absPath: string; refPath: string; relPath: string }[],
): Promise<FileStateResult[]> {
  const results: FileStateResult[] = [];
  for (const file of files) {
    const { symbol, state, details, size } = await getFileState(file.absPath, file.refPath);
    results.push({ path: file.relPath, symbol, state, details, size });
  }
  return results;
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
      console.log(formatDryRun(`push ${formatCount(needsPush.length, 'file')}`));
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
      console.log(formatPushResult(r.path, r.bytesTransferred));
    }
    for (const r of failed) {
      console.error(formatTransferFail(r.path, r.error ?? 'unknown error'));
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
      console.log(formatDryRun(`pull ${formatCount(needsPull.length, 'file')}`));
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
      console.log(formatPullResult(r.path, r.bytesTransferred));
    }
    for (const r of failed) {
      console.error(formatTransferFail(r.path, r.error ?? 'unknown error'));
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
          console.log(`  ${OUTPUT_SYMBOLS.push} ${file.relPath} - pushed`);
        }
      } else {
        errors++;
        if (!globalOpts.quiet) {
          console.error(`  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - push failed: ${result.error}`);
        }
      }
    } else if (!existsSync(file.absPath)) {
      const result = await pullFile(ref, file.absPath, config, repoRoot);
      if (result.success) {
        const entry = await createCacheEntry(file.absPath, file.relPath, ref.hash);
        await writeCacheEntry(cacheDir, entry);
        pulled++;
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(`  ${OUTPUT_SYMBOLS.pull} ${file.relPath} - pulled`);
        }
      } else {
        errors++;
        if (!globalOpts.quiet) {
          console.error(`  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - pull failed: ${result.error}`);
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
            console.log(`  ${OUTPUT_SYMBOLS.push} ${file.relPath} - pushed (modified)`);
          }
        } else {
          errors++;
        }
      } else if (!globalOpts.quiet && !globalOpts.json) {
        console.log(`  ${OUTPUT_SYMBOLS.pass} ${file.relPath} - up to date`);
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
  const verbose = globalOpts.verbose;
  const repoRoot = findRepoRoot();

  if (globalOpts.dryRun && fix) {
    if (useJson) {
      console.log(formatJsonDryRun(['run doctor diagnostics', 'fix detected issues']));
    } else {
      console.log(formatDryRun('run doctor diagnostics and fix detected issues'));
    }
    return;
  }

  const issues: DoctorIssue[] = [];

  // --- Resolve config (may fail) ---
  let config: Awaited<ReturnType<typeof resolveConfig>> | null = null;
  try {
    config = await resolveConfig(repoRoot, repoRoot);
  } catch (err) {
    issues.push({
      type: 'config',
      severity: 'error',
      message: `Config error: ${err instanceof Error ? err.message : String(err)}`,
      fixed: false,
      fixable: false,
    });
  }

  // --- STATUS section ---
  const files = resolveTrackedFiles([], repoRoot);
  const fileStates = await computeFileStates(files);

  if (!useJson) {
    if (fileStates.length > 0) {
      for (const r of fileStates) {
        console.log(formatFileState(r.symbol as FileStateSymbol, r.path, r.details, r.size));
      }
      console.log('');
      const stateCounts: Record<string, number> = {};
      for (const r of fileStates) {
        stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1;
      }
      const stateParts = Object.entries(stateCounts)
        .filter(([, v]) => v > 0)
        .map(([state, count]) => `${count} ${state}`);
      console.log(`${formatCount(fileStates.length, 'tracked file')}: ${stateParts.join(', ')}`);
      console.log('');
    } else {
      console.log('No tracked files found.');
      console.log('');
    }
  }

  // --- CONFIGURATION section ---
  const configIssues = checkConfig(config, repoRoot, verbose);
  renderSection('CONFIGURATION', configIssues, verbose, useJson);
  issues.push(...configIssues);

  // --- GIT HOOKS section ---
  const hookIssues = checkHooks(repoRoot, fix, verbose);
  renderSection('GIT HOOKS', hookIssues, verbose, useJson);
  issues.push(...hookIssues);

  // --- INTEGRITY section ---
  const integrityIssues: DoctorIssue[] = [];
  try {
    const blobsyDir = join(repoRoot, '.blobsy');
    if (!existsSync(blobsyDir)) {
      if (fix) {
        await ensureDir(blobsyDir);
        integrityIssues.push({
          type: 'directory',
          severity: 'error',
          message: 'Created .blobsy/ directory',
          fixed: true,
          fixable: true,
        });
      } else {
        integrityIssues.push({
          type: 'directory',
          severity: 'error',
          message: '.blobsy/ directory missing',
          fixed: false,
          fixable: true,
        });
      }
    }

    const allBrefs = findBrefFiles(repoRoot, repoRoot);

    // Check for orphaned .bref files
    for (const relPath of allBrefs) {
      const absPath = join(repoRoot, relPath);
      const refPath = join(repoRoot, brefPath(relPath));

      if (!existsSync(absPath) && existsSync(refPath)) {
        try {
          const ref = await readBref(refPath);
          if (!ref.remote_key) {
            integrityIssues.push({
              type: 'orphan',
              severity: 'error',
              message: `${relPath}: .bref exists but local file missing and no remote_key`,
              fixed: false,
              fixable: false,
            });
          }
        } catch (err) {
          integrityIssues.push({
            type: 'bref',
            severity: 'error',
            message: `${relPath}: invalid .bref file: ${err instanceof Error ? err.message : String(err)}`,
            fixed: false,
            fixable: false,
          });
        }
      }
    }

    // Check for missing .gitignore entries
    for (const relPath of allBrefs) {
      const absPath = join(repoRoot, relPath);
      const fileName = basename(absPath);
      const fileDir = dirname(absPath);
      const gitignorePath = join(fileDir, '.gitignore');

      if (existsSync(join(repoRoot, brefPath(relPath)))) {
        const entries = await readBlobsyBlock(gitignorePath);
        if (!entries.includes(fileName)) {
          if (fix) {
            await addGitignoreEntry(fileDir, fileName);
            integrityIssues.push({
              type: 'gitignore',
              severity: 'error',
              message: `${relPath}: added missing .gitignore entry`,
              fixed: true,
              fixable: true,
            });
          } else {
            integrityIssues.push({
              type: 'gitignore',
              severity: 'error',
              message: `${relPath}: missing from .gitignore`,
              fixed: false,
              fixable: true,
            });
          }
        }
      }
    }
  } catch (err) {
    integrityIssues.push({
      type: 'integrity',
      severity: 'error',
      message: `Integrity check error: ${err instanceof Error ? err.message : String(err)}`,
      fixed: false,
      fixable: false,
    });
  }
  renderSection('INTEGRITY', integrityIssues, verbose, useJson);
  issues.push(...integrityIssues);

  // --- BACKEND section ---
  const backendIssues: DoctorIssue[] = [];
  if (config) {
    try {
      await runHealthCheck(config, repoRoot);
      if (verbose) {
        backendIssues.push({
          type: 'backend',
          severity: 'info',
          message: 'Backend reachable and writable',
          fixed: false,
          fixable: false,
        });
      }
    } catch (err) {
      backendIssues.push({
        type: 'backend',
        severity: 'error',
        message: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
        fixed: false,
        fixable: false,
      });
    }
  }
  renderSection('BACKEND', backendIssues, verbose, useJson);
  issues.push(...backendIssues);

  // --- Output ---
  if (useJson) {
    const severityCounts = { errors: 0, warnings: 0, info: 0 };
    for (const i of issues) {
      if (i.severity === 'error') {
        severityCounts.errors++;
      } else if (i.severity === 'warning') {
        severityCounts.warnings++;
      } else {
        severityCounts.info++;
      }
    }
    console.log(
      formatJson({
        status: {
          files: fileStates.map((r) => ({
            path: r.path,
            state: r.state,
            details: r.details,
            ...(r.size != null ? { size: r.size } : {}),
          })),
        },
        issues: issues.map((i) => ({
          type: i.type,
          severity: i.severity,
          message: i.message,
          fixed: i.fixed,
          fixable: i.fixable,
        })),
        summary: {
          total: issues.length,
          ...severityCounts,
          fixed: issues.filter((i) => i.fixed).length,
          unfixed: issues.filter((i) => !i.fixed).length,
        },
      }),
    );
  } else {
    const actionableIssues = issues.filter((i) => i.severity !== 'info' || i.fixed);
    if (actionableIssues.length === 0) {
      console.log('No issues found.');
    } else {
      const unfixed = issues.filter((i) => !i.fixed && i.severity !== 'info').length;
      if (unfixed > 0) {
        console.log(
          `${formatCount(unfixed, 'issue')} found.${!fix ? ' Run with --fix to attempt repairs.' : ''}`,
        );
      } else if (issues.some((i) => i.fixed)) {
        console.log('All issues fixed.');
      }
    }
  }

  if (issues.some((i) => !i.fixed && i.severity === 'error')) {
    process.exitCode = 1;
  }
}

/** Render a doctor section with heading (non-JSON only). */
function renderSection(
  name: string,
  sectionIssues: DoctorIssue[],
  verbose: boolean,
  useJson: boolean,
): void {
  if (useJson) {
    return;
  }

  // In non-verbose mode, skip sections with no failures/warnings
  const hasProblems = sectionIssues.some((i) => i.severity !== 'info' || i.fixed);
  if (!verbose && !hasProblems) {
    return;
  }

  console.log(formatHeading(name));
  for (const issue of sectionIssues) {
    if (issue.fixed) {
      console.log(formatCheckFixed(issue.message));
    } else if (issue.severity === 'error') {
      console.log(formatCheckFail(issue.message));
    } else if (issue.severity === 'warning') {
      console.log(formatCheckWarn(issue.message));
    } else if (verbose) {
      console.log(formatCheckPass(issue.message));
    }
  }
  console.log('');
}

const KNOWN_CONFIG_KEYS = new Set([
  'backend',
  'backends',
  'externalize',
  'compress',
  'ignore',
  'remote',
  'sync',
  'checksum',
]);

const VALID_COMPRESS_ALGORITHMS = new Set(['zstd', 'gzip', 'brotli', 'none']);

/** Run configuration validation checks for doctor. */
function checkConfig(
  config: BlobsyConfig | null,
  repoRoot: string,
  verbose: boolean,
): DoctorIssue[] {
  const issues: DoctorIssue[] = [];

  // 1. Config file exists
  const configPath = getConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    issues.push({
      type: 'config',
      severity: 'error',
      message: 'No .blobsy.yml found',
      fixed: false,
      fixable: false,
    });
    return issues; // Can't check further without config file
  } else if (verbose) {
    issues.push({
      type: 'config',
      severity: 'info',
      message: '.blobsy.yml valid',
      fixed: false,
      fixable: false,
    });
  }

  // 2. Config loaded successfully (already handled by resolveConfig wrapping)
  if (!config) {
    return issues;
  }

  // 3. Global config valid (if present)
  try {
    const globalPath = getGlobalConfigPath();
    if (existsSync(globalPath)) {
      try {
        // loadConfigFile is async but we only need to validate YAML parsing
        void loadConfigFile(globalPath);
        if (verbose) {
          issues.push({
            type: 'config',
            severity: 'info',
            message: `Global config valid (${globalPath})`,
            fixed: false,
            fixable: false,
          });
        }
      } catch (err) {
        issues.push({
          type: 'config',
          severity: 'warning',
          message: `Global config invalid: ${err instanceof Error ? err.message : String(err)}`,
          fixed: false,
          fixable: false,
        });
      }
    } else if (verbose) {
      issues.push({
        type: 'config',
        severity: 'info',
        message: 'Global config: not present',
        fixed: false,
        fixable: false,
      });
    }
  } catch {
    // getGlobalConfigPath may fail if HOME is not set; ignore
  }

  // 4. Backend resolves
  try {
    const resolved = resolveBackend(config);
    if (verbose) {
      issues.push({
        type: 'config',
        severity: 'info',
        message: `Backend: ${resolved.url ?? resolved.path ?? resolved.type} (${resolved.type})`,
        fixed: false,
        fixable: false,
      });
    }

    // 5. Backend URL parseable
    if (resolved.url) {
      try {
        parseBackendUrl(resolved.url);
      } catch (err) {
        issues.push({
          type: 'config',
          severity: 'error',
          message: `Backend URL invalid: ${err instanceof Error ? err.message : String(err)}`,
          fixed: false,
          fixable: false,
        });
      }
    }
  } catch (err) {
    issues.push({
      type: 'config',
      severity: 'error',
      message: `Backend resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      fixed: false,
      fixable: false,
    });
  }

  // 6. externalize.min_size parseable
  if (config.externalize?.min_size != null) {
    try {
      parseSize(config.externalize.min_size);
    } catch (err) {
      issues.push({
        type: 'config',
        severity: 'warning',
        message: `externalize.min_size invalid: ${err instanceof Error ? err.message : String(err)}`,
        fixed: false,
        fixable: false,
      });
    }
  }

  // 7. compress.min_size parseable
  if (config.compress?.min_size != null) {
    try {
      parseSize(config.compress.min_size);
    } catch (err) {
      issues.push({
        type: 'config',
        severity: 'warning',
        message: `compress.min_size invalid: ${err instanceof Error ? err.message : String(err)}`,
        fixed: false,
        fixable: false,
      });
    }
  }

  // 8. compress.algorithm valid
  if (config.compress?.algorithm && !VALID_COMPRESS_ALGORITHMS.has(config.compress.algorithm)) {
    issues.push({
      type: 'config',
      severity: 'warning',
      message: `Unknown compression algorithm: ${config.compress.algorithm}`,
      fixed: false,
      fixable: false,
    });
  }

  // 9. Unknown top-level config keys
  // We need the raw config object with unknown keys. Since resolveConfig merges and validates,
  // check by reading the raw YAML. For now, check the parsed config keys.
  const rawKeys = Object.keys(config);
  for (const key of rawKeys) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      issues.push({
        type: 'config',
        severity: 'info',
        message: `Unknown config key: ${key}`,
        fixed: false,
        fixable: false,
      });
    }
  }

  return issues;
}

/** Run git hook checks for doctor. */
function checkHooks(repoRoot: string, fix: boolean, verbose: boolean): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const hookDir = join(repoRoot, '.git', 'hooks');

  for (const hook of HOOK_TYPES) {
    const hookPath = join(hookDir, hook.name);

    if (!existsSync(hookPath)) {
      if (fix) {
        // Hook installation is handled by handleHooks; just report
        issues.push({
          type: 'hooks',
          severity: 'warning',
          message: `${hook.name} hook not installed`,
          fixed: false,
          fixable: true,
        });
      } else {
        issues.push({
          type: 'hooks',
          severity: 'warning',
          message: `${hook.name} hook not installed`,
          fixed: false,
          fixable: true,
        });
      }
      continue;
    }

    // Hook exists — check content
    const content = readFileSync(hookPath, 'utf-8');
    if (!content.includes('blobsy hook')) {
      issues.push({
        type: 'hooks',
        severity: 'warning',
        message: `${hook.name} hook exists but is not a blobsy hook`,
        fixed: false,
        fixable: false,
      });
      continue;
    }

    // Blobsy-managed hook — check executable
    try {
      accessSync(hookPath, constants.X_OK);
      if (verbose) {
        issues.push({
          type: 'hooks',
          severity: 'info',
          message: `${hook.name} hook installed`,
          fixed: false,
          fixable: false,
        });
      }
    } catch {
      if (fix) {
        void chmod(hookPath, 0o755);
        issues.push({
          type: 'hooks',
          severity: 'warning',
          message: `${hook.name} hook made executable`,
          fixed: true,
          fixable: true,
        });
      } else {
        issues.push({
          type: 'hooks',
          severity: 'warning',
          message: `${hook.name} hook not executable`,
          fixed: false,
          fixable: true,
        });
      }
    }
  }

  return issues;
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
            formatWarning('Could not detect absolute path to blobsy executable.') +
              '\n   Hook will use "blobsy" from PATH.' +
              '\n   To ensure hooks work, install blobsy globally: pnpm link --global',
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
      console.log(`\n${formatCount(unpushed.length, 'file')} not pushed.`);
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
      console.log(`\n${formatCount(missing.length, 'file')} missing remote blobs.`);
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

  console.log(`blobsy pre-push: uploading ${formatCount(unpushed.length, 'blob')}...`);

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

/**
 * Stage 2 command handlers: push, pull, sync, health, doctor, hooks,
 * check-unpushed, pre-push-check, hook.
 */

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { appendFile, chmod, readdir, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Command } from 'commander';

import {
  getConfigPath,
  getGlobalConfigPath,
  loadConfigFile,
  parseSize,
  resolveConfig,
} from './config.js';
import { ensureDir } from './fs-utils.js';
import { addGitignoreEntry, readBlobsyBlock, removeGitignoreEntry } from './gitignore.js';
import { computeHash } from './hash.js';
import {
  findRepoRoot,
  findBrefFiles,
  isDirectory,
  resolveRepoPath,
  stripBrefExtension,
  toRepoRelative,
  brefPath,
} from './paths.js';
import { readBref, writeBref } from './ref.js';
import { createCacheEntry, getMergeBase, getStatCacheDir, writeCacheEntry } from './stat-cache.js';
import { pushFile, pullFile, blobExists, runHealthCheck, resolveBackend } from './transfer.js';
import { isAwsCliAvailable } from './backend-aws-cli.js';
import { isRcloneAvailable } from './backend-rclone.js';
import { parseBackendUrl } from './backend-url.js';
import {
  c,
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
import {
  ValidationError,
  BREF_EXTENSION,
  BREF_FORMAT,
  FILE_STATE_SYMBOLS,
  HOOK_MANAGED_MARKER,
} from './types.js';
import {
  HOOK_TYPES,
  detectBlobsyPath,
  gitHooksDir,
  hooksDisabledByEnv,
  installHook,
  wouldInstallHook,
} from './hooks.js';

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

/**
 * Expand user-supplied paths (files, directories, or none = whole repo)
 * into the tracked files they cover, as repo-relative + absolute + .bref
 * path triples.
 */
export function resolveTrackedFiles(
  paths: string[],
  repoRoot: string,
): { relPath: string; absPath: string; refPath: string }[] {
  const targetPaths =
    paths.length > 0
      ? paths.map((p) => resolveRepoPath(stripBrefExtension(p), repoRoot))
      : [repoRoot];

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

  let ref;
  try {
    ref = await readBref(refPath);
  } catch {
    return { symbol: FILE_STATE_SYMBOLS.missing, state: 'corrupt_bref', details: 'invalid .bref' };
  }

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

/**
 * Compute the sync-state symbol/details for each tracked file (synced,
 * modified, new, missing, corrupt .bref) as shown by status and doctor.
 */
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

/**
 * `blobsy push` — upload tracked blobs to the configured backend.
 * Refuses modified-since-track content without --force (DS-03); dry-run
 * mirrors the real plan including refusals and exit codes (CLI-02).
 */
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
      console.log(c.muted('No tracked files to push.'));
    }
    return;
  }

  if (globalOpts.dryRun) {
    // Mirror the real plan including the DS-03 hash checks (dry-run is the
    // primary trust mechanism for agents; it must not promise a push the
    // real run would refuse).
    const needsPush = [];
    let wouldTransfer = 0;
    let wouldBlock = 0;
    for (const file of files) {
      const ref = await readBref(file.refPath);
      // Missing payload with nothing pushed: the real run fails in
      // pushFile — don't promise a push that cannot happen (Bugbot r5).
      if (!ref.remote_key && !existsSync(file.absPath)) {
        needsPush.push(`error ${file.relPath} (local file missing; nothing to push)`);
        wouldBlock++;
        continue;
      }
      const modified = existsSync(file.absPath) && (await computeHash(file.absPath)) !== ref.hash;
      if (ref.remote_key && !opts.force) {
        if (modified) {
          needsPush.push(`warn ${file.relPath} (modified since last push; would not upload)`);
          wouldBlock++;
        }
        continue;
      }
      if (modified && !opts.force) {
        needsPush.push(`refuse ${file.relPath} (changed since track; would need --force)`);
        wouldBlock++;
        continue;
      }
      needsPush.push(`push ${file.relPath}`);
      wouldTransfer++;
    }
    if (globalOpts.json) {
      console.log(formatJsonDryRun(needsPush));
    } else {
      for (const a of needsPush) {
        console.log(formatDryRun(a));
      }
      console.log(formatDryRun(`push ${formatCount(wouldTransfer, 'file')}`));
    }
    // Dry-run reports the exit code the real run would produce — scripts
    // gate on it (Bugbot round 4).
    if (wouldBlock > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const results: TransferResult[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const ref = await readBref(file.refPath);

    if (ref.remote_key && !opts.force) {
      // Not silently "already pushed" if the payload changed since the last
      // push — say so, or the user believes the remote has their edits.
      let note = 'already pushed';
      if (existsSync(file.absPath)) {
        const currentHash = await computeHash(file.absPath);
        if (currentHash !== ref.hash) {
          note = 'modified since last push (run `blobsy sync` or `blobsy push --force`)';
          warnings.push(`${file.relPath}: ${note}`);
        }
      }
      if (!globalOpts.quiet && !globalOpts.json) {
        if (note === 'already pushed') {
          console.log(c.muted(`  ${file.relPath}  ${note}`));
        } else {
          console.error(`  ${OUTPUT_SYMBOLS.warn} ${file.relPath}  ${note}`);
        }
      }
      continue;
    }

    if (existsSync(file.absPath)) {
      const currentHash = await computeHash(file.absPath);
      if (currentHash !== ref.hash) {
        if (opts.force) {
          ref.hash = currentHash;
          ref.size = statSync(file.absPath).size;
        } else {
          // Push sanity check (review finding DS-03): the design forbids
          // uploading new bytes under the stale hash recorded at track time —
          // the key would claim a sha256 the content doesn't have, and every
          // subsequent pull fails verification for everyone.
          results.push({
            path: file.relPath,
            success: false,
            action: 'push',
            error:
              'local file changed since it was tracked (hash mismatch); ' +
              'run `blobsy track` to re-track, `blobsy pull --force` to restore, ' +
              'or `blobsy push --force` to push the current content',
          });
          continue;
        }
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
    // warnings must be countable in the summary: a warning-only blocked push
    // exits 1, and JSON automation reads the summary, not stderr (Bugbot
    // round 4).
    console.log(
      formatJson({
        pushed: results,
        warnings,
        summary: {
          total: results.length,
          succeeded: succeeded.length,
          failed: failed.length,
          warnings: warnings.length,
        },
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

  // A blocked push (modified since last push, upload skipped) must be
  // visible to automation, not read as success.
  if (failed.length > 0 || warnings.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * `blobsy pull` — download blobs for tracked files. Refuses to overwrite
 * locally modified files without --force; dry-run mirrors the plan.
 */
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
      console.log(c.muted('No tracked files to pull.'));
    }
    return;
  }

  if (globalOpts.dryRun) {
    // Mirror the real per-file plan (review finding CLI-02): count only files
    // that would actually transfer, and surface refusals.
    const needsPull = [];
    let wouldTransfer = 0;
    let wouldRefuse = 0;
    for (const file of files) {
      const ref = await readBref(file.refPath);
      if (!ref.remote_key) {
        continue;
      }
      if (existsSync(file.absPath) && !opts.force) {
        const currentHash = await computeHash(file.absPath);
        if (currentHash === ref.hash) {
          continue;
        }
        needsPull.push(`refuse ${file.relPath} (locally modified; would need --force)`);
        wouldRefuse++;
        continue;
      }
      needsPull.push(`pull ${file.relPath}`);
      wouldTransfer++;
    }
    if (globalOpts.json) {
      console.log(formatJsonDryRun(needsPull));
    } else {
      for (const a of needsPull) {
        console.log(formatDryRun(a));
      }
      console.log(formatDryRun(`pull ${formatCount(wouldTransfer, 'file')}`));
    }
    // Dry-run reports the exit code the real run would produce — refusals
    // exit with the conflict code (Bugbot round 4).
    if (wouldRefuse > 0) {
      process.exitCode = CONFLICT_EXIT_CODE;
    }
    return;
  }

  const results: TransferResult[] = [];
  let refused = 0;

  for (const file of files) {
    const ref = await readBref(file.refPath);

    if (!ref.remote_key) {
      // Not necessarily "not pushed": with the pre-push hook flow the blob may
      // exist remotely while the .bref update recording remote_key is still
      // uncommitted on the pusher's machine (Bugbot round 10).
      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(
          c.muted(
            `  ${file.relPath}  no remote_key (not pushed, or pusher hasn't committed the .bref update)`,
          ),
        );
      }
      continue;
    }

    if (!opts.force && existsSync(file.absPath)) {
      const currentHash = await computeHash(file.absPath);
      if (currentHash === ref.hash) {
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(c.muted(`  ${file.relPath}  already up to date`));
        }
        continue;
      }
      // Local file modified: never silently overwrite it (review finding
      // DS-02 — the design mandates refusal with exit code 2).
      refused++;
      if (!globalOpts.quiet) {
        console.error(
          `  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - local file modified; ` +
            'use `blobsy pull --force` to overwrite (or `blobsy push` to keep local)',
        );
      }
      continue;
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
        summary: {
          total: results.length,
          succeeded: succeeded.length,
          failed: failed.length,
          refused,
        },
      }),
    );
  } else if (!globalOpts.quiet) {
    for (const r of succeeded) {
      console.log(formatPullResult(r.path, r.bytesTransferred));
    }
    for (const r of failed) {
      console.error(formatTransferFail(r.path, r.error ?? 'unknown error'));
    }
    const refusedNote = refused > 0 ? `, ${refused} refused (locally modified)` : '';
    console.log(
      `Done: ${succeeded.length} pulled${failed.length > 0 ? `, ${failed.length} failed` : ''}${refusedNote}.`,
    );
  }

  if (refused > 0) {
    process.exitCode = CONFLICT_EXIT_CODE;
  } else if (failed.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * Per-file three-way sync decision (blobsy-stat-cache-design.md decision table).
 *
 * The stat cache supplies the merge base — the last hash this machine knew was
 * in sync. Without consulting it, sync cannot tell "user edited the file" from
 * ".bref updated by git pull" and destroys one side (review finding DS-01).
 */
type SyncDecision =
  | { action: 'push_new' }
  | { action: 'missing_local' }
  | { action: 'pull_missing' }
  | { action: 'up_to_date'; localHash: string }
  | { action: 'pull' }
  | { action: 'push'; localHash: string }
  | { action: 'conflict'; localHash: string; baseHash: string; refHash: string }
  | { action: 'ambiguous'; localHash: string }
  | { action: 'refuse_modified'; localHash: string };

async function decideSyncAction(
  file: { relPath: string; absPath: string; refPath: string },
  ref: { hash: string; remote_key?: string | undefined },
  cacheDir: string,
): Promise<SyncDecision> {
  if (!ref.remote_key) {
    // No local payload and nothing ever pushed: there is nothing to push
    // AND nothing to pull — report clearly instead of planning a push that
    // can only fail (Bugbot round 4).
    if (!existsSync(file.absPath)) {
      return { action: 'missing_local' };
    }
    // Payload changed since track: `blobsy push` refuses this state
    // (DS-03) and sync must not become the bypass that silently uploads
    // re-hashed content (Bugbot r9).
    const localHash = await computeHash(file.absPath);
    if (localHash !== ref.hash) {
      return { action: 'refuse_modified', localHash };
    }
    return { action: 'push_new' };
  }
  if (!existsSync(file.absPath)) {
    return { action: 'pull_missing' };
  }

  const localHash = await computeHash(file.absPath);
  if (localHash === ref.hash) {
    return { action: 'up_to_date', localHash };
  }

  const baseHash = await getMergeBase(cacheDir, file.relPath);
  if (!baseHash) {
    return { action: 'ambiguous', localHash };
  }
  if (localHash === baseHash && ref.hash !== baseHash) {
    return { action: 'pull' };
  }
  if (localHash !== baseHash && ref.hash === baseHash) {
    return { action: 'push', localHash };
  }
  return { action: 'conflict', localHash, baseHash, refHash: ref.hash };
}

/** Exit code for conflict-class outcomes (matches ConflictError). */
const CONFLICT_EXIT_CODE = 2;

const SYNC_CONFLICT_HELP =
  'resolve with an explicit choice: `blobsy push --force` (keep local) or `blobsy pull --force` (take remote)';

const SYNC_AMBIGUOUS_HELP =
  'no merge base to tell a local edit from a git pull; run `blobsy push` or `blobsy pull` explicitly';

const SYNC_MISSING_LOCAL_HELP =
  'local file missing and no remote_key recorded (no known remote copy to pull); ' +
  'if a teammate pushed this file, they still need to commit the updated .bref; ' +
  'otherwise restore the file or run `blobsy untrack` to stop tracking it';

const SYNC_REFUSE_MODIFIED_HELP =
  'changed since track; re-track with `blobsy track <path>` then `blobsy push --force`';

/**
 * `blobsy sync` — bidirectional: push unpushed, pull missing/outdated.
 * Conflicts and tracking ambiguity exit 2 (CONFLICT_EXIT_CODE); transfer
 * errors exit 1.
 */
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
    // Dry-run must run the same per-file decision logic as the real sync
    // (review finding CLI-02) — it previously omitted the modified→push and
    // conflict cases entirely, reporting "Everything up to date".
    const actions = [];
    let wouldConflict = 0;
    let wouldError = 0;
    for (const file of files) {
      const ref = await readBref(file.refPath);
      const decision = await decideSyncAction(file, ref, cacheDir);
      switch (decision.action) {
        case 'push_new':
        case 'push':
          actions.push(`push ${file.relPath}`);
          break;
        case 'missing_local':
          actions.push(`error ${file.relPath} (${SYNC_MISSING_LOCAL_HELP})`);
          wouldError++;
          break;
        case 'refuse_modified':
          actions.push(`refuse ${file.relPath} (${SYNC_REFUSE_MODIFIED_HELP})`);
          wouldError++;
          break;
        case 'pull_missing':
        case 'pull':
          actions.push(`pull ${file.relPath}`);
          break;
        case 'conflict':
          actions.push(`conflict ${file.relPath} (would error; ${SYNC_CONFLICT_HELP})`);
          wouldConflict++;
          break;
        case 'ambiguous':
          actions.push(`error ${file.relPath} (${SYNC_AMBIGUOUS_HELP})`);
          wouldConflict++;
          break;
        case 'up_to_date':
          break;
      }
    }
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const a of actions) {
        console.log(formatDryRun(a));
      }
      if (actions.length === 0) {
        console.log(c.muted('Everything up to date.'));
      }
    }
    // Dry-run reports the exit code the real run would produce — scripts
    // gate on it (Bugbot round 4).
    if (wouldConflict > 0) {
      process.exitCode = CONFLICT_EXIT_CODE;
    } else if (wouldError > 0) {
      process.exitCode = 1;
    }
    return;
  }

  let pushed = 0;
  let pulled = 0;
  let errors = 0;
  let conflicts = 0;

  const pushModified = async (
    file: { relPath: string; absPath: string; refPath: string },
    ref: Awaited<ReturnType<typeof readBref>>,
    localHash: string,
  ): Promise<void> => {
    const modifiedRef = {
      ...ref,
      hash: localHash,
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
      if (!globalOpts.quiet) {
        console.error(`  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - push failed: ${result.error}`);
      }
    }
  };

  for (const file of files) {
    const ref = await readBref(file.refPath);
    const decision = await decideSyncAction(file, ref, cacheDir);

    switch (decision.action) {
      case 'push_new': {
        // First push of a tracked file. decideSyncAction has verified the
        // payload still matches the .bref hash — a modified payload is
        // refused (refuse_modified below) exactly like `blobsy push`
        // (DS-03, Bugbot r9); sync must not silently re-hash and upload.
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
            console.error(
              `  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - push failed: ${result.error}`,
            );
          }
        }
        break;
      }

      case 'missing_local': {
        errors++;
        if (!globalOpts.quiet) {
          console.error(`  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - ${SYNC_MISSING_LOCAL_HELP}`);
        }
        break;
      }

      case 'refuse_modified': {
        errors++;
        if (!globalOpts.quiet) {
          console.error(
            `  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - push refused: ${SYNC_REFUSE_MODIFIED_HELP}`,
          );
        }
        break;
      }

      case 'pull_missing':
      case 'pull': {
        const result = await pullFile(ref, file.absPath, config, repoRoot);
        if (result.success) {
          const entry = await createCacheEntry(file.absPath, file.relPath, ref.hash);
          await writeCacheEntry(cacheDir, entry);
          pulled++;
          if (!globalOpts.quiet && !globalOpts.json) {
            const note = decision.action === 'pull' ? ' (updated)' : '';
            console.log(`  ${OUTPUT_SYMBOLS.pull} ${file.relPath} - pulled${note}`);
          }
        } else {
          errors++;
          if (!globalOpts.quiet) {
            console.error(
              `  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - pull failed: ${result.error}`,
            );
          }
        }
        break;
      }

      case 'push': {
        await pushModified(file, ref, decision.localHash);
        break;
      }

      case 'conflict': {
        conflicts++;
        if (!globalOpts.quiet) {
          console.error(
            `  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - conflict: local and .bref both changed ` +
              `since last sync (local ${decision.localHash.slice(0, 19)}…, ` +
              `ref ${decision.refHash.slice(0, 19)}…); ${SYNC_CONFLICT_HELP}`,
          );
        }
        break;
      }

      case 'ambiguous': {
        conflicts++;
        if (!globalOpts.quiet) {
          console.error(`  ${OUTPUT_SYMBOLS.fail} ${file.relPath} - ${SYNC_AMBIGUOUS_HELP}`);
        }
        break;
      }

      case 'up_to_date': {
        // Refresh the merge base so future syncs have a reliable base.
        const entry = await createCacheEntry(file.absPath, file.relPath, decision.localHash);
        await writeCacheEntry(cacheDir, entry);
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(c.muted(`  ${OUTPUT_SYMBOLS.pass} ${file.relPath} - up to date`));
        }
        break;
      }
    }
  }

  if (globalOpts.json) {
    console.log(formatJson({ sync: { pushed, pulled, errors, conflicts, total: files.length } }));
  } else if (!globalOpts.quiet) {
    const conflictNote = conflicts > 0 ? `, ${conflicts} conflicts` : '';
    console.log(
      `Sync complete: ${pushed} pushed, ${pulled} pulled, ${errors} errors${conflictNote}.`,
    );
  }

  if (conflicts > 0) {
    process.exitCode = CONFLICT_EXIT_CODE;
  } else if (errors > 0) {
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
      console.log(formatJson({ status: 'ok', message: 'Backend is reachable.' }));
    } else {
      console.log(c.success('Backend is reachable.'));
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
  const useJson = globalOpts.json;
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
      console.log(c.muted('No tracked files found.'));
      console.log('');
    }
  }

  // --- CONFIGURATION section ---
  const configIssues = await checkConfig(config, repoRoot, verbose);
  renderSection('CONFIGURATION', configIssues, verbose, useJson);
  issues.push(...configIssues);

  // --- GIT HOOKS section ---
  const hookIssues = await checkHooks(repoRoot, fix, verbose);
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
    } else {
      // Writability check
      const testFile = join(blobsyDir, '.doctor-write-test');
      try {
        writeFileSync(testFile, '');
        unlinkSync(testFile);
      } catch {
        integrityIssues.push({
          type: 'directory',
          severity: 'error',
          message: '.blobsy/ is not writable',
          fixed: false,
          fixable: false,
        });
      }
    }

    // .blobsy/ gitignore check
    const rootGitignore = join(repoRoot, '.gitignore');
    if (existsSync(rootGitignore)) {
      const content = readFileSync(rootGitignore, 'utf-8');
      const hasBlobsyEntry = content.split('\n').some((line) => {
        const trimmed = line.trim();
        return trimmed === '.blobsy' || trimmed === '.blobsy/';
      });
      if (!hasBlobsyEntry) {
        if (fix) {
          await appendFile(rootGitignore, '\n.blobsy/\n');
          integrityIssues.push({
            type: 'gitignore',
            severity: 'error',
            message: 'Added .blobsy/ to root .gitignore',
            fixed: true,
            fixable: true,
          });
        } else {
          integrityIssues.push({
            type: 'gitignore',
            severity: 'error',
            message: '.blobsy/ not in root .gitignore',
            fixed: false,
            fixable: true,
          });
        }
      }
    } else if (fix) {
      await appendFile(rootGitignore, '.blobsy/\n');
      integrityIssues.push({
        type: 'gitignore',
        severity: 'error',
        message: 'Created root .gitignore with .blobsy/ entry',
        fixed: true,
        fixable: true,
      });
    } else {
      integrityIssues.push({
        type: 'gitignore',
        severity: 'error',
        message: '.blobsy/ not in root .gitignore (no .gitignore found)',
        fixed: false,
        fixable: true,
      });
    }

    const allBrefs = findBrefFiles(repoRoot, repoRoot);

    // .bref validation and orphan checks
    for (const relPath of allBrefs) {
      const absPath = join(repoRoot, relPath);
      const refPath = join(repoRoot, brefPath(relPath));

      if (existsSync(refPath)) {
        try {
          const ref = await readBref(refPath);

          // Format version check
          if (ref.format !== BREF_FORMAT) {
            integrityIssues.push({
              type: 'bref',
              severity: 'warning',
              message: `${relPath}: unexpected .bref format "${ref.format}" (expected "${BREF_FORMAT}")`,
              fixed: false,
              fixable: false,
            });
          }

          // Orphan check
          if (!existsSync(absPath) && !ref.remote_key) {
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

    // Dangling .gitignore entry check
    const checkedDirs = new Set<string>();
    for (const relPath of allBrefs) {
      const fileDir = dirname(join(repoRoot, relPath));
      if (checkedDirs.has(fileDir)) {
        continue;
      }
      checkedDirs.add(fileDir);

      const entries = await readBlobsyBlock(join(fileDir, '.gitignore'));
      for (const entry of entries) {
        const entryBref = join(fileDir, entry + BREF_EXTENSION);
        if (!existsSync(entryBref)) {
          if (fix) {
            await removeGitignoreEntry(fileDir, entry);
            integrityIssues.push({
              type: 'gitignore',
              severity: 'warning',
              message: `${entry}: removed dangling .gitignore entry`,
              fixed: true,
              fixable: true,
            });
          } else {
            integrityIssues.push({
              type: 'gitignore',
              severity: 'warning',
              message: `${entry}: dangling .gitignore entry (no .bref found)`,
              fixed: false,
              fixable: true,
            });
          }
        }
      }
    }

    // Stat cache checks
    const cacheDir = getStatCacheDir(repoRoot);
    if (existsSync(cacheDir)) {
      try {
        const cacheFiles = await readdir(cacheDir);
        for (const file of cacheFiles) {
          if (!file.endsWith('.json')) {
            continue;
          }
          const cachePath = join(cacheDir, file);
          try {
            const raw = readFileSync(cachePath, 'utf-8');
            const entry = JSON.parse(raw) as { path?: string };
            if (entry.path) {
              const entryBref = join(repoRoot, brefPath(entry.path));
              if (!existsSync(entryBref)) {
                if (fix) {
                  await unlink(cachePath);
                  integrityIssues.push({
                    type: 'cache',
                    severity: 'info',
                    message: `Removed stale cache entry for ${entry.path}`,
                    fixed: true,
                    fixable: true,
                  });
                } else if (verbose) {
                  integrityIssues.push({
                    type: 'cache',
                    severity: 'info',
                    message: `Stale cache entry for ${entry.path}`,
                    fixed: false,
                    fixable: true,
                  });
                }
              }
            }
          } catch {
            if (fix) {
              await unlink(cachePath);
              integrityIssues.push({
                type: 'cache',
                severity: 'warning',
                message: `Removed corrupt cache file: ${file}`,
                fixed: true,
                fixable: true,
              });
            } else {
              integrityIssues.push({
                type: 'cache',
                severity: 'warning',
                message: `Corrupt cache file: ${file}`,
                fixed: false,
                fixable: true,
              });
            }
          }
        }
      } catch {
        // readdir failure -- skip cache checks
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
    // Tool availability checks
    try {
      const resolved = resolveBackend(config);
      if (resolved.type === 's3') {
        if (!isAwsCliAvailable()) {
          backendIssues.push({
            type: 'backend',
            severity: 'info',
            message: 'AWS CLI not found; using built-in S3 SDK',
            fixed: false,
            fixable: false,
          });
        } else if (verbose) {
          backendIssues.push({
            type: 'backend',
            severity: 'info',
            message: 'AWS CLI available',
            fixed: false,
            fixable: false,
          });
        }
      } else if (resolved.type === 'gcs' || resolved.type === 'azure') {
        if (!isRcloneAvailable()) {
          backendIssues.push({
            type: 'backend',
            severity: 'error',
            message: `rclone not found; required for ${resolved.type} backend`,
            fixed: false,
            fixable: false,
          });
        } else {
          if (verbose) {
            backendIssues.push({
              type: 'backend',
              severity: 'info',
              message: 'rclone available',
              fixed: false,
              fixable: false,
            });
          }
          if (!resolved.rclone_remote) {
            backendIssues.push({
              type: 'backend',
              severity: 'error',
              message: `rclone_remote not set for ${resolved.type} backend`,
              fixed: false,
              fixable: false,
            });
          } else {
            // Verify the remote exists
            try {
              const output = execFileSync('rclone', ['listremotes'], {
                stdio: 'pipe',
                timeout: 5000,
              }).toString();
              const remotes = output
                .split('\n')
                .map((r) => r.replace(/:$/, '').trim())
                .filter(Boolean);
              if (!remotes.includes(resolved.rclone_remote)) {
                backendIssues.push({
                  type: 'backend',
                  severity: 'error',
                  message: `rclone remote "${resolved.rclone_remote}" not found in rclone config`,
                  fixed: false,
                  fixable: false,
                });
              } else if (verbose) {
                backendIssues.push({
                  type: 'backend',
                  severity: 'info',
                  message: `rclone remote "${resolved.rclone_remote}" found`,
                  fixed: false,
                  fixable: false,
                });
              }
            } catch {
              backendIssues.push({
                type: 'backend',
                severity: 'warning',
                message: 'Could not list rclone remotes to verify configuration',
                fixed: false,
                fixable: false,
              });
            }
          }
        }
      } else if (resolved.type === 'command') {
        for (const field of ['push_command', 'pull_command', 'exists_command'] as const) {
          const cmd = resolved[field];
          if (cmd) {
            const binary = cmd.split(/\s+/)[0];
            if (binary) {
              try {
                execFileSync('which', [binary], { stdio: 'pipe' });
                if (verbose) {
                  backendIssues.push({
                    type: 'backend',
                    severity: 'info',
                    message: `${field} binary found: ${binary}`,
                    fixed: false,
                    fixable: false,
                  });
                }
              } catch {
                backendIssues.push({
                  type: 'backend',
                  severity: 'error',
                  message: `${field} binary not found: ${binary}`,
                  fixed: false,
                  fixable: false,
                });
              }
            }
          }
        }
      }
    } catch {
      // resolveBackend may fail -- already reported in config section
    }

    // Health check
    try {
      await runHealthCheck(config, repoRoot);
      if (verbose) {
        backendIssues.push({
          type: 'backend',
          severity: 'info',
          message: 'Backend reachable',
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
      console.log(c.success('No issues found.'));
    } else {
      const unfixed = issues.filter((i) => !i.fixed && i.severity !== 'info').length;
      if (unfixed > 0) {
        console.log(
          `${formatCount(unfixed, 'issue')} found.${!fix ? ' Run with --fix to attempt repairs.' : ''}`,
        );
      } else if (issues.some((i) => i.fixed)) {
        console.log(c.success('All issues fixed.'));
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
  'trust_command_backends',
]);

const VALID_COMPRESS_ALGORITHMS = new Set(['zstd', 'gzip', 'brotli', 'none']);

/** Compute Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from<number>({ length: n + 1 }).fill(0),
  );
  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}

/** Find the closest match from a set of candidates within edit distance 2. */
function findClosestMatch(input: string, candidates: Set<string>): string | undefined {
  let best: string | undefined;
  let bestDist = 3; // max distance threshold
  for (const candidate of candidates) {
    const dist = levenshtein(input, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/** Run configuration validation checks for doctor. */
async function checkConfig(
  config: BlobsyConfig | null,
  repoRoot: string,
  verbose: boolean,
): Promise<DoctorIssue[]> {
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
        // Await the parse: a corrupt global config was reported "valid"
        // because the rejected promise was discarded (review finding CLI-03).
        await loadConfigFile(globalPath);
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

  // 9. Unknown top-level config keys with did-you-mean suggestions
  const rawKeys = Object.keys(config);
  for (const key of rawKeys) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      let message = `Unknown config key: ${key}`;
      const suggestion = findClosestMatch(key, KNOWN_CONFIG_KEYS);
      if (suggestion) {
        message += ` (did you mean "${suggestion}"?)`;
      }
      issues.push({
        type: 'config',
        severity: 'info',
        message,
        fixed: false,
        fixable: false,
      });
    }
  }

  return issues;
}

/** Run git hook checks for doctor. */
async function checkHooks(
  repoRoot: string,
  fix: boolean,
  verbose: boolean,
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const hookDir = gitHooksDir(repoRoot);

  for (const hook of HOOK_TYPES) {
    const hookPath = join(hookDir, hook.name);

    if (!existsSync(hookPath)) {
      if (fix && hooksDisabledByEnv()) {
        // Setup/init honor BLOBSY_NO_HOOKS; --fix must not sneak hooks
        // back in behind the same opt-out.
        issues.push({
          type: 'hooks',
          severity: 'warning',
          message: `${hook.name} hook not installed (BLOBSY_NO_HOOKS is set; not installing)`,
          fixed: false,
          fixable: false,
        });
      } else if (fix) {
        await installHook(repoRoot, hook);
        issues.push({
          type: 'hooks',
          severity: 'warning',
          message: `Installed ${hook.name} hook`,
          fixed: true,
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

    // Hook exists — check ownership by the exact managed marker, matching
    // install/uninstall (Bugbot r5): a user hook that merely CALLS blobsy
    // is theirs, and doctor must not report it as blobsy-managed.
    const content = readFileSync(hookPath, 'utf-8');
    if (!content.includes(HOOK_MANAGED_MARKER)) {
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
        // Await: a failed chmod was reported "fixed" (review finding CLI-03).
        await chmod(hookPath, 0o755);
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

export async function handleHooks(
  action: string,
  _opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();

  if (action !== 'install' && action !== 'uninstall') {
    throw new ValidationError(`Unknown hooks action: ${action}. Use 'install' or 'uninstall'.`);
  }

  if (globalOpts.dryRun) {
    // Mirror the real run's per-hook decisions (BLOBSY_NO_HOOKS opt-out,
    // ownership marker checks) instead of listing every hook — a plan that
    // promises actions the real run would skip misleads automation
    // (Bugbot r12).
    const actions: string[] = [];
    if (action === 'install' && !hooksDisabledByEnv()) {
      for (const hook of HOOK_TYPES) {
        if (await wouldInstallHook(repoRoot, hook)) {
          actions.push(`install ${hook.name} hook`);
        }
      }
    } else if (action === 'uninstall') {
      const hookDir = gitHooksDir(repoRoot);
      for (const hook of HOOK_TYPES) {
        const hookPath = join(hookDir, hook.name);
        if (
          existsSync(hookPath) &&
          (await readFile(hookPath, 'utf-8')).includes(HOOK_MANAGED_MARKER)
        ) {
          actions.push(`uninstall ${hook.name} hook`);
        }
      }
    }
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
    if (hooksDisabledByEnv()) {
      // Same opt-out setup/init honor; an explicit install must not
      // silently override it (Bugbot: env flag inconsistently honored).
      if (!globalOpts.quiet) {
        console.log('BLOBSY_NO_HOOKS is set; not installing hooks.');
      }
      return;
    }

    const blobsyPath = detectBlobsyPath();

    if (blobsyPath === 'blobsy' && !globalOpts.quiet) {
      console.warn(
        formatWarning('Could not detect absolute path to blobsy executable.') +
          '\n   Hook will use "blobsy" from PATH.' +
          '\n   To ensure hooks work, install blobsy globally: pnpm link --global',
      );
    }

    for (const hook of HOOK_TYPES) {
      const installed = await installHook(repoRoot, hook);
      if (!globalOpts.quiet) {
        if (installed) {
          console.log(`Installed ${hook.name} hook.`);
        } else {
          console.log(
            `Existing ${hook.name} hook found (not managed by blobsy); left in place. ` +
              `Add manually: blobsy hook ${hook.gitEvent}`,
          );
        }
      }
    }

    if (!globalOpts.quiet && blobsyPath !== 'blobsy') {
      console.log(`  Using executable: ${blobsyPath}`);
    }
  } else {
    const hookDir = gitHooksDir(repoRoot);
    for (const hook of HOOK_TYPES) {
      const hookPath = join(hookDir, hook.name);
      if (existsSync(hookPath)) {
        const content = await readFile(hookPath, 'utf-8');
        // Delete only hooks carrying the exact managed marker — a user
        // hook that merely calls blobsy is theirs (review finding HK-03).
        if (content.includes(HOOK_MANAGED_MARKER)) {
          await unlink(hookPath);
          if (!globalOpts.quiet) {
            console.log(`Uninstalled ${hook.name} hook.`);
          }
        } else if (!globalOpts.quiet) {
          console.log(
            `${hook.name.charAt(0).toUpperCase() + hook.name.slice(1)} hook not managed by blobsy; leaving it in place.`,
          );
        }
      } else if (!globalOpts.quiet) {
        console.log(`No ${hook.name} hook found.`);
      }
    }
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
      console.log(c.success('All tracked files have been pushed.'));
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
  const errors: { path: string; message: string }[] = [];

  for (const relPath of allBrefs) {
    const refPath = join(repoRoot, brefPath(relPath));
    const ref = await readBref(refPath);

    if (!ref.remote_key) {
      missing.push(relPath);
      continue;
    }

    // An invalid remote_key (or a backend failure) must be reported per-file,
    // not crash the whole check — this runs as a pre-push hook.
    let exists: boolean;
    try {
      exists = await blobExists(ref.remote_key, config, repoRoot, relPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ path: relPath, message });
      continue;
    }
    if (!exists) {
      missing.push(relPath);
    }
  }

  const failures = missing.length + errors.length;

  if (globalOpts.json) {
    console.log(formatJson({ missing, errors, count: failures, ok: failures === 0 }));
  } else {
    if (failures === 0) {
      console.log(c.success('All refs have remote blobs. Safe to push.'));
    } else {
      for (const path of missing) {
        console.log(`  ${path}  missing remote blob`);
      }
      for (const { path, message } of errors) {
        console.log(`  ${path}  check failed: ${message}`);
      }
      if (missing.length > 0) {
        console.log(`\n${formatCount(missing.length, 'file')} missing remote blobs.`);
        console.log('Run blobsy push first.');
      }
      if (errors.length > 0) {
        console.log(`\n${formatCount(errors.length, 'file')} could not be checked.`);
      }
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

async function handlePreCommitHook(repoRoot: string): Promise<void> {
  // Find staged .bref files
  let stagedOutput: string;
  try {
    stagedOutput = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`blobsy pre-commit: failed to query staged files: ${message}`);
    process.exitCode = 1;
    return;
  }
  const staged = stagedOutput
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

  // Push each unpushed blob. This hook is the design's primary prevention
  // layer against committed-ref-without-blob data loss, so a failed upload
  // MUST abort the git push (review finding HK-01) — never report success
  // on a network error or missing credentials.
  const cacheDir = getStatCacheDir(repoRoot);
  const failures: { relPath: string; error: string }[] = [];
  for (const relPath of unpushed) {
    const refPath = join(repoRoot, brefPath(relPath));
    const ref = await readBref(refPath);
    const absPath = join(repoRoot, relPath);

    // Same push sanity check as explicit push (DS-03): never upload new
    // bytes under the stale hash recorded at track time.
    if (existsSync(absPath)) {
      const currentHash = await computeHash(absPath);
      if (currentHash !== ref.hash) {
        failures.push({
          relPath,
          error:
            'local file changed since it was tracked (hash mismatch); ' +
            'run `blobsy track` to re-track, then commit and push again',
        });
        continue;
      }
    }

    const result = await pushFile(absPath, relPath, ref, config, repoRoot);

    if (result.success && result.refUpdates) {
      const updatedRef = { ...ref, ...result.refUpdates };
      await writeBref(refPath, updatedRef);
      if (existsSync(absPath)) {
        const entry = await createCacheEntry(absPath, relPath, updatedRef.hash);
        await writeCacheEntry(cacheDir, entry);
      }
    } else if (!result.success) {
      failures.push({ relPath, error: result.error ?? 'unknown error' });
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`blobsy pre-push: ${OUTPUT_SYMBOLS.fail} ${f.relPath}: ${f.error}`);
    }
    console.error(
      `blobsy pre-push: ${formatCount(failures.length, 'upload')} failed; aborting push. ` +
        'Collaborators would see committed refs with no blob behind them. ' +
        'Fix the error and retry, or bypass with `git push --no-verify`.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('blobsy pre-push: all blobs uploaded.');
  // The remote_key updates land in the working tree, not in the commits this
  // push is sending (a pre-push hook cannot amend the outgoing commits), so
  // collaborators cannot pull until a follow-up commit records them (Bugbot
  // round 10). Say so instead of leaving the .bref changes silently dirty.
  console.log(
    'blobsy pre-push: remote keys were recorded in the .bref files in your ' +
      'working tree; this push does not include them. Commit them so ' +
      `collaborators can pull: git add '*.bref' && git commit -m 'Record blobsy remote keys'`,
  );
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

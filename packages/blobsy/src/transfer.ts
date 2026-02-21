/**
 * Transfer coordinator.
 *
 * Orchestrate file transfers: select backend, manage concurrency,
 * handle compression, manage atomic writes, coordinate push/pull/sync.
 */

import { existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  BackendConfig,
  BlobsyConfig,
  ResolvedBackendConfig,
  TransferResult,
  YRef,
} from './types.js';
import { BlobsyError, ValidationError } from './types.js';
import { computeHash } from './hash.js';
import { resolveLocalPath } from './backend-url.js';
import { localPush, localPull, localBlobExists, localHealthCheck } from './backend-local.js';
import { commandPush, commandPull, commandBlobExists } from './backend-command.js';
import type { CommandTemplateVars } from './backend-command.js';
import { evaluateTemplate, getCompressSuffix } from './template.js';
import { compressFile, decompressFile, shouldCompress } from './compress.js';
import { getCompressConfig } from './config.js';
import { normalizePath, toRepoRelative } from './paths.js';
import { ensureDir } from './fs-utils.js';

/**
 * Resolve the effective backend config.
 *
 * If `BLOBSY_BACKEND_URL` is set, it overrides the configured backend URL.
 * Useful for testing and CI/CD environment-specific overrides.
 */
export function resolveBackend(config: BlobsyConfig): ResolvedBackendConfig {
  const envUrl = process.env.BLOBSY_BACKEND_URL;
  if (envUrl) {
    return resolveBackendType({ url: envUrl });
  }

  const backendName = config.backend ?? 'default';
  const backends = config.backends;

  if (!backends) {
    throw new ValidationError('No backends configured. Run blobsy init first.');
  }

  const backend = backends[backendName];
  if (!backend) {
    throw new ValidationError(`Backend "${backendName}" not found in config.`, [
      `Available backends: ${Object.keys(backends).join(', ')}`,
    ]);
  }

  return resolveBackendType(backend);
}

function resolveBackendType(backend: BackendConfig): ResolvedBackendConfig {
  if (backend.type) {
    return backend as ResolvedBackendConfig;
  }

  // Infer type from url
  if (backend.url) {
    const url = backend.url;
    if (url.startsWith('s3://')) {
      return { ...backend, type: 's3' };
    }
    if (url.startsWith('gs://')) {
      return { ...backend, type: 'gcs' };
    }
    if (url.startsWith('azure://')) {
      return { ...backend, type: 'azure' };
    }
    if (url.startsWith('local:')) {
      return { ...backend, type: 'local', path: url.slice('local:'.length) };
    }
  }

  if (backend.push_command) {
    return { ...backend, type: 'command' };
  }

  throw new ValidationError('Cannot determine backend type from config.');
}

/** Push a single file to remote. Returns refUpdates for the caller to merge into the ref. */
export async function pushFile(
  filePath: string,
  repoPath: string,
  ref: Readonly<YRef>,
  config: BlobsyConfig,
  repoRoot: string,
): Promise<TransferResult> {
  const backend = resolveBackend(config);
  const compressConfig = getCompressConfig(config);

  // Determine compression
  const shouldDoCompress = shouldCompress(repoPath, ref.size, compressConfig);
  const algorithm = shouldDoCompress ? compressConfig.algorithm : undefined;
  const compressSuffix = getCompressSuffix(algorithm);

  // Evaluate remote key template
  const keyTemplate =
    config.remote?.key_template ??
    '{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}';
  const remoteKey = evaluateTemplate(keyTemplate, {
    hash: ref.hash,
    repoPath,
    compressSuffix,
  });

  let uploadPath = filePath;
  let tempCompressedPath: string | undefined;
  let compressedSize: number | undefined;
  let compressedAlgorithm: string | undefined;

  try {
    // Compress if needed
    if (shouldDoCompress && algorithm && algorithm !== 'none') {
      tempCompressedPath = `${filePath}.blobsy-compress-${randomBytes(4).toString('hex')}${compressSuffix}`;
      compressedSize = await compressFile(filePath, tempCompressedPath, algorithm);
      compressedAlgorithm = algorithm;
      uploadPath = tempCompressedPath;
    }

    // Upload
    await pushToBackend(backend, uploadPath, remoteKey, repoPath, repoRoot);

    return {
      path: repoPath,
      success: true,
      action: 'push',
      bytesTransferred: compressedSize ?? ref.size,
      refUpdates: {
        remote_key: remoteKey,
        compressed: compressedAlgorithm,
        compressed_size: compressedSize,
      },
    };
  } catch (err) {
    return {
      path: repoPath,
      success: false,
      action: 'push',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Clean up temp compressed file
    if (tempCompressedPath && existsSync(tempCompressedPath)) {
      try {
        await unlink(tempCompressedPath);
      } catch {
        // Ignore
      }
    }
  }
}

/** Pull a single file from remote. */
export async function pullFile(
  ref: YRef,
  localPath: string,
  config: BlobsyConfig,
  repoRoot: string,
): Promise<TransferResult> {
  const backend = resolveBackend(config);

  if (!ref.remote_key) {
    return {
      path: normalizePath(toRepoRelative(localPath, repoRoot)),
      success: false,
      action: 'pull',
      error: 'No remote_key in .yref. File has not been pushed.',
    };
  }

  const repoPath = normalizePath(toRepoRelative(localPath, repoRoot));
  const tmpSuffix = randomBytes(8).toString('hex');

  try {
    if (ref.compressed && ref.compressed !== 'none') {
      // Download compressed to temp, decompress to final
      const tmpCompressed = `${localPath}.blobsy-pull-${tmpSuffix}${getCompressSuffix(ref.compressed)}`;
      const tmpDecompressed = `${localPath}.blobsy-pull-${tmpSuffix}`;

      try {
        await pullFromBackend(backend, ref.remote_key, tmpCompressed, repoPath, repoRoot);
        await decompressFile(tmpCompressed, tmpDecompressed, ref.compressed);

        // Verify hash of decompressed content
        const actualHash = await computeHash(tmpDecompressed);
        if (actualHash !== ref.hash) {
          throw new BlobsyError(
            `Hash mismatch after decompression: expected ${ref.hash}, got ${actualHash}`,
            'validation',
          );
        }

        await ensureDir(join(localPath, '..'));
        await rename(tmpDecompressed, localPath);
      } finally {
        for (const tmp of [tmpCompressed, tmpDecompressed]) {
          try {
            if (existsSync(tmp)) {
              await unlink(tmp);
            }
          } catch {
            // Ignore
          }
        }
      }
    } else {
      // Download directly with hash verification
      await pullFromBackend(backend, ref.remote_key, localPath, repoPath, repoRoot, ref.hash);
    }

    return {
      path: repoPath,
      success: true,
      action: 'pull',
      bytesTransferred: ref.size,
    };
  } catch (err) {
    return {
      path: repoPath,
      success: false,
      action: 'pull',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Check if a remote blob exists. */
export function blobExists(remoteKey: string, config: BlobsyConfig, repoRoot: string): boolean {
  const backend = resolveBackend(config);
  return existsOnBackend(backend, remoteKey, repoRoot);
}

/** Run a health check on the configured backend. */
export async function runHealthCheck(config: BlobsyConfig, repoRoot: string): Promise<void> {
  const backend = resolveBackend(config);

  switch (backend.type) {
    case 'local': {
      const remotePath = resolveLocalPath(backend.path ?? '', repoRoot);
      await localHealthCheck(remotePath);
      break;
    }
    case 'command': {
      // No health check for command backends
      break;
    }
    case 's3':
    case 'gcs':
    case 'azure':
      throw new BlobsyError(
        `Cloud backend health check not yet implemented: ${backend.type}`,
        'unknown',
      );
    default: {
      const _exhaustive: never = backend.type;
      throw new BlobsyError(
        `Unknown backend type: ${(_exhaustive as ResolvedBackendConfig).type}`,
        'validation',
      );
    }
  }
}

async function pushToBackend(
  backend: ResolvedBackendConfig,
  localPath: string,
  remoteKey: string,
  repoPath: string,
  repoRoot: string,
): Promise<void> {
  switch (backend.type) {
    case 'local': {
      const remotePath = resolveLocalPath(backend.path ?? '', repoRoot);
      await localPush(localPath, remotePath, remoteKey);
      break;
    }
    case 'command': {
      if (!backend.push_command) {
        throw new ValidationError('No push_command configured for command backend.');
      }
      const vars: CommandTemplateVars = {
        local: resolve(localPath),
        remote: `${backend.bucket ?? ''}/${remoteKey}`,
        relative_path: repoPath,
        bucket: backend.bucket ?? '',
      };
      commandPush(backend.push_command, vars);
      break;
    }
    case 's3':
    case 'gcs':
    case 'azure':
      throw new BlobsyError(`Cloud push not yet implemented: ${backend.type}`, 'unknown');
    default: {
      const _exhaustive: never = backend.type;
      throw new BlobsyError(
        `Unknown backend type: ${(_exhaustive as ResolvedBackendConfig).type}`,
        'validation',
      );
    }
  }
}

async function pullFromBackend(
  backend: ResolvedBackendConfig,
  remoteKey: string,
  localPath: string,
  repoPath: string,
  repoRoot: string,
  expectedHash?: string,
): Promise<void> {
  switch (backend.type) {
    case 'local': {
      const remotePath = resolveLocalPath(backend.path ?? '', repoRoot);
      await localPull(remotePath, remoteKey, localPath, expectedHash);
      break;
    }
    case 'command': {
      if (!backend.pull_command) {
        throw new ValidationError('No pull_command configured for command backend.');
      }
      const tmpSuffix = randomBytes(8).toString('hex');
      const tempPath = `${localPath}.blobsy-cmd-${tmpSuffix}`;
      const vars: CommandTemplateVars = {
        local: resolve(tempPath),
        remote: `${backend.bucket ?? ''}/${remoteKey}`,
        relative_path: repoPath,
        bucket: backend.bucket ?? '',
      };
      commandPull(backend.pull_command, vars, tempPath);

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
      break;
    }
    case 's3':
    case 'gcs':
    case 'azure':
      throw new BlobsyError(`Cloud pull not yet implemented: ${backend.type}`, 'unknown');
    default: {
      const _exhaustive: never = backend.type;
      throw new BlobsyError(
        `Unknown backend type: ${(_exhaustive as ResolvedBackendConfig).type}`,
        'validation',
      );
    }
  }
}

function existsOnBackend(
  backend: ResolvedBackendConfig,
  remoteKey: string,
  repoRoot: string,
): boolean {
  switch (backend.type) {
    case 'local': {
      const remotePath = resolveLocalPath(backend.path ?? '', repoRoot);
      return localBlobExists(remotePath, remoteKey);
    }
    case 'command': {
      if (!backend.exists_command) {
        return false;
      }
      const vars: CommandTemplateVars = {
        local: '',
        remote: `${backend.bucket ?? ''}/${remoteKey}`,
        relative_path: '',
        bucket: backend.bucket ?? '',
      };
      return commandBlobExists(backend.exists_command, vars);
    }
    case 's3':
    case 'gcs':
    case 'azure':
      throw new BlobsyError(`Cloud exists check not yet implemented: ${backend.type}`, 'unknown');
    default: {
      const _exhaustive: never = backend.type;
      throw new BlobsyError(
        `Unknown backend type: ${(_exhaustive as ResolvedBackendConfig).type}`,
        'validation',
      );
    }
  }
}

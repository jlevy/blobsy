/**
 * Transfer coordinator.
 *
 * Orchestrate file transfers: select backend, manage concurrency,
 * handle compression, manage atomic writes, coordinate push/pull/sync.
 */

import { existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  Backend,
  BackendConfig,
  BlobsyConfig,
  ResolvedBackendConfig,
  TransferResult,
  YRef,
} from './types.js';
import { BlobsyError, ValidationError } from './types.js';
import { computeHash } from './hash.js';
import { parseBackendUrl, resolveLocalPath } from './backend-url.js';
import { LocalBackend } from './backend-local.js';
import { CommandBackend } from './backend-command.js';
import { S3Backend } from './backend-s3.js';
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

  throw new ValidationError('Cannot determine backend type from config.', [
    'Set a url (e.g. s3://bucket/prefix or local:../path) or explicit type in .blobsy.yml.',
  ]);
}

/** Create a Backend instance from resolved config. */
export function createBackend(config: ResolvedBackendConfig, repoRoot: string): Backend {
  switch (config.type) {
    case 'local': {
      const remotePath = resolveLocalPath(config.path ?? '', repoRoot);
      return new LocalBackend(remotePath);
    }
    case 'command': {
      return new CommandBackend({
        pushCommand: config.push_command,
        pullCommand: config.pull_command,
        existsCommand: config.exists_command,
        bucket: config.bucket,
      });
    }
    case 's3': {
      const parsed = config.url ? parseBackendUrl(config.url) : undefined;
      return new S3Backend({
        bucket: config.bucket ?? parsed?.bucket ?? '',
        prefix: config.prefix ?? parsed?.prefix,
        region: config.region,
        endpoint: config.endpoint,
      });
    }
    case 'gcs':
    case 'azure':
      throw new BlobsyError(`Cloud backend not yet implemented: ${config.type}`, 'unknown');
    default: {
      const _exhaustive: never = config.type;
      throw new BlobsyError(
        `Unknown backend type: ${(_exhaustive as ResolvedBackendConfig).type}`,
        'validation',
      );
    }
  }
}

/** Push a single file to remote. Returns refUpdates for the caller to merge into the ref. */
export async function pushFile(
  filePath: string,
  repoPath: string,
  ref: Readonly<YRef>,
  config: BlobsyConfig,
  repoRoot: string,
): Promise<TransferResult> {
  const resolvedBackend = resolveBackend(config);
  const backend = createBackend(resolvedBackend, repoRoot);
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
    await backend.push(uploadPath, remoteKey);

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
  const resolvedBackend = resolveBackend(config);
  const backend = createBackend(resolvedBackend, repoRoot);

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
        await backend.pull(ref.remote_key, tmpCompressed);
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
      await backend.pull(ref.remote_key, localPath, ref.hash);
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
export async function blobExists(
  remoteKey: string,
  config: BlobsyConfig,
  repoRoot: string,
): Promise<boolean> {
  const resolvedBackend = resolveBackend(config);
  const backend = createBackend(resolvedBackend, repoRoot);
  return backend.exists(remoteKey);
}

/** Run a health check on the configured backend. */
export async function runHealthCheck(config: BlobsyConfig, repoRoot: string): Promise<void> {
  const resolvedBackend = resolveBackend(config);
  const backend = createBackend(resolvedBackend, repoRoot);
  await backend.healthCheck();
}

/**
 * Shared type definitions for blobsy.
 *
 * Central types used across the codebase. No runtime logic.
 */

/** Contents of a `.yref` file -- the metadata that Git tracks for each externalized blob. */
export interface YRef {
  /** Format identifier, e.g. "blobsy-yref/0.1" */
  format: string;
  /** Content hash: "sha256:<64-char-lowercase-hex>" */
  hash: string;
  /** File size in bytes (original, before compression) */
  size: number;
  /** Evaluated remote key (absent until first push) */
  remote_key?: string | undefined;
  /** Compression algorithm used (absent if uncompressed) */
  compressed?: string | undefined;
  /** Compressed size in bytes (absent if uncompressed) */
  compressed_size?: number | undefined;
}

/** Stable field ordering for .yref serialization. */
export const YREF_FIELD_ORDER = [
  'format',
  'hash',
  'size',
  'remote_key',
  'compressed',
  'compressed_size',
] as const;

export const YREF_FORMAT = 'blobsy-yref/0.1';
export const YREF_COMMENT_HEADER =
  '# blobsy -- https://github.com/jlevy/blobsy\n# Run: blobsy status | blobsy --help\n\n';
export const YREF_EXTENSION = '.yref';

/** Per-file stat cache entry for fast change detection and three-way merge. */
export interface StatCacheEntry {
  /** Repo-relative file path */
  path: string;
  /** Content hash: "sha256:..." */
  hash: string;
  /** File size in bytes */
  size: number;
  /** BigInt nanosecond mtime, serialized as string (JSON cannot represent BigInt) */
  mtimeNs: string | null;
  /** Millisecond mtime for fallback */
  mtimeMs: number;
  /** Epoch ms when this entry was cached */
  cachedAt: number;
}

export type BackendType = 's3' | 'gcs' | 'azure' | 'local' | 'command';

/** Configuration for a single backend. */
export interface BackendConfig {
  type?: BackendType | undefined;
  url?: string | undefined;
  bucket?: string | undefined;
  prefix?: string | undefined;
  /** Local filesystem path (for local backend) */
  path?: string | undefined;
  region?: string | undefined;
  endpoint?: string | undefined;
  /** Shell command template for push (command backend) */
  push_command?: string | undefined;
  /** Shell command template for pull (command backend) */
  pull_command?: string | undefined;
  /** Shell command template for exists check (command backend) */
  exists_command?: string | undefined;
}

/** BackendConfig with type resolved (always set after resolveBackend). */
export type ResolvedBackendConfig = BackendConfig & { type: BackendType };

/** Externalization rules: decide which files to externalize from git. */
export interface ExternalizeConfig {
  /** Minimum file size for externalization (e.g. "1mb" or bytes) */
  min_size: string | number;
  /** Glob patterns to always externalize regardless of size */
  always: string[];
  /** Glob patterns to never externalize */
  never: string[];
}

/** Compression configuration. */
export interface CompressConfig {
  /** Minimum file size for compression */
  min_size: string | number;
  /** Compression algorithm */
  algorithm: 'zstd' | 'gzip' | 'brotli' | 'none';
  /** Glob patterns to always compress */
  always: string[];
  /** Glob patterns to never compress */
  never: string[];
}

/** Full blobsy configuration, merged from multiple .blobsy.yml files. */
export interface BlobsyConfig {
  /** Default backend name */
  backend?: string | undefined;
  /** Named backend configurations */
  backends?: Record<string, BackendConfig> | undefined;
  /** Externalization rules */
  externalize?: ExternalizeConfig | undefined;
  /** Compression rules */
  compress?: CompressConfig | undefined;
  /** File patterns to ignore entirely */
  ignore?: string[] | undefined;
  /** Remote key template config */
  remote?: { key_template: string } | undefined;
  /** Sync tool and parallelism settings */
  sync?: { tools: string[]; parallel: number } | undefined;
  /** Checksum algorithm config */
  checksum?: { algorithm: string } | undefined;
}

/**
 * State symbols for `blobsy status` output.
 *
 * - circle: new (tracked, not committed, not pushed)
 * - half-right: committed, not pushed to remote
 * - half-left: pushed/synced but .yref not yet committed
 * - check: fully synced (committed + pushed)
 * - tilde: local file modified since last track
 * - question: .yref exists but local file is missing
 * - deleted: staged for deletion (in trash)
 */
export type FileStateSymbol = '\u25CB' | '\u25D0' | '\u25D1' | '\u2713' | '~' | '?' | '\u2297';

export const FILE_STATE_SYMBOLS = {
  new: '\u25CB' as const, // ○
  committed_not_pushed: '\u25D0' as const, // ◐
  pushed_not_committed: '\u25D1' as const, // ◑
  synced: '\u2713' as const, // ✓
  modified: '~' as const,
  missing: '?' as const,
  deleted: '\u2297' as const, // ⊗
};

export type SyncAction =
  | { action: 'up_to_date' }
  | { action: 'pull'; remoteKey: string }
  | { action: 'push'; newHash: string }
  | { action: 'conflict'; localHash: string; remoteHash: string; baseHash: string }
  | { action: 'error'; reason: string };

export type ErrorCategory =
  | 'authentication'
  | 'not_found'
  | 'network'
  | 'permission'
  | 'quota'
  | 'storage_full'
  | 'validation'
  | 'conflict'
  | 'unknown';

/** Structured CLI error with category and optional troubleshooting. */
export class BlobsyError extends Error {
  constructor(
    message: string,
    public readonly category: ErrorCategory,
    public readonly exitCode = 1,
    public readonly suggestions?: string[],
  ) {
    super(message);
    this.name = 'BlobsyError';
  }
}

/** Conflict error (exit code 2). */
export class ConflictError extends BlobsyError {
  constructor(message: string, suggestions?: string[]) {
    super(message, 'conflict', 2, suggestions);
    this.name = 'ConflictError';
  }
}

/** Validation error for malformed input. */
export class ValidationError extends BlobsyError {
  constructor(message: string, suggestions?: string[]) {
    super(message, 'validation', 1, suggestions);
    this.name = 'ValidationError';
  }
}

/** Result of a file transfer operation. */
export interface TransferResult {
  path: string;
  success: boolean;
  action: 'push' | 'pull';
  bytesTransferred?: number | undefined;
  error?: string | undefined;
  /** Ref fields updated by a successful push. Caller merges into ref before writing .yref. */
  refUpdates?:
    | {
        remote_key: string;
        compressed: string | undefined;
        compressed_size: number | undefined;
      }
    | undefined;
}

/** Parsed backend URL from `blobsy init <url>`. */
export interface ParsedBackendUrl {
  type: BackendType;
  bucket?: string | undefined;
  prefix?: string | undefined;
  path?: string | undefined;
  originalUrl: string;
}

/**
 * Abstract backend interface. Each backend type (local, command, s3)
 * implements this to provide push/pull/exists/health operations.
 */
export interface Backend {
  readonly type: BackendType;
  push(localPath: string, remoteKey: string): Promise<void>;
  pull(remoteKey: string, localPath: string, expectedHash?: string): Promise<void>;
  exists(remoteKey: string): Promise<boolean>;
  healthCheck(): Promise<void>;
}

/** Global CLI options shared across all commands. */
export interface GlobalOptions {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  dryRun: boolean;
}

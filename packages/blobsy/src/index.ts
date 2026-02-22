/**
 * blobsy -- Store large files anywhere. Track them in Git.
 *
 * Library exports for programmatic usage.
 */

export type {
  Backend,
  BlobsyConfig,
  BackendConfig,
  BackendType,
  CompressConfig,
  ErrorCategory,
  ExternalizeConfig,
  FileStateSymbol,
  GlobalOptions,
  ParsedBackendUrl,
  StatCacheEntry,
  SyncAction,
  TransferResult,
  Bref,
} from './types.js';

export {
  BlobsyError,
  ConflictError,
  ValidationError,
  BREF_FORMAT,
  BREF_EXTENSION,
} from './types.js';

export { computeHash, hashString, isValidHash } from './hash.js';
export { readBref, writeBref } from './ref.js';
export {
  resolveConfig,
  loadConfigFile,
  mergeConfigs,
  getBuiltinDefaults,
  parseSize,
} from './config.js';
export { parseBackendUrl, validateBackendUrl, formatBackendUrl } from './backend-url.js';
export {
  findRepoRoot,
  toRepoRelative,
  stripBrefExtension,
  brefPath,
  normalizePath,
  getCacheEntryPath,
} from './paths.js';
export { addGitignoreEntry, removeGitignoreEntry, readBlobsyBlock } from './gitignore.js';
export { shouldExternalize, filterFilesForExternalization } from './externalize.js';
export { formatSize, formatJson, formatJsonMessage, formatJsonError } from './format.js';

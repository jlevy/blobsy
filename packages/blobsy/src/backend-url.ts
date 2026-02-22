/**
 * Backend URL parsing.
 *
 * Parse backend URLs (s3://, gs://, azure://, local:) into structured config.
 * Validate per-scheme rules and reject unrecognized schemes.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { BackendType, ParsedBackendUrl } from './types.js';
import { ValidationError } from './types.js';

/** Minimum bucket name length for cloud backends (S3/GCS/Azure standard) */
const MIN_BUCKET_NAME_LENGTH = 3;

/** Maximum bucket name length for cloud backends (S3/GCS/Azure standard) */
const MAX_BUCKET_NAME_LENGTH = 63;

/** Supported backend URL schemes and their corresponding backend types */
const SUPPORTED_SCHEMES: Record<string, BackendType> = {
  's3:': 's3',
  'gs:': 'gcs',
  'azure:': 'azure',
  'local:': 'local',
};

const SCHEME_EXAMPLES = [
  '  s3://my-bucket/prefix/',
  '  gs://my-bucket/prefix/',
  '  azure://my-container/prefix/',
  '  local:../blobsy-remote',
];

/** Parse a backend URL into structured config. */
export function parseBackendUrl(url: string): ParsedBackendUrl {
  if (!url || url.trim().length === 0) {
    throw new ValidationError('Backend URL is required.', [
      'Provide a URL like: blobsy init s3://my-bucket/prefix/',
      ...SCHEME_EXAMPLES,
    ]);
  }

  // Reject query strings and fragments
  if (url.includes('?') || url.includes('#')) {
    throw new ValidationError(`Backend URL must not contain query strings or fragments: ${url}`);
  }

  // Check for cloud schemes (s3://, gs://, azure://)
  const urlLower = url.toLowerCase();

  for (const [scheme, type] of Object.entries(SUPPORTED_SCHEMES)) {
    if (urlLower.startsWith(scheme) && scheme !== 'local:') {
      return parseCloudUrl(url, scheme, type);
    }
  }

  // Check for local: scheme
  if (urlLower.startsWith('local:')) {
    return parseLocalUrl(url);
  }

  // Bare path without scheme
  if (url.startsWith('/') || url.startsWith('.') || url.startsWith('~')) {
    throw new ValidationError(`Bare paths are not supported. Did you mean 'local:${url}'?`, [
      `Use 'local:' prefix for local backends: local:${url}`,
      ...SCHEME_EXAMPLES,
    ]);
  }

  // Unrecognized scheme
  const colonIndex = url.indexOf(':');
  const unknownScheme = colonIndex > 0 ? url.slice(0, colonIndex + 1) : url;
  throw new ValidationError(`Unrecognized backend URL scheme: ${unknownScheme}`, [
    'Supported schemes:',
    ...SCHEME_EXAMPLES,
  ]);
}

function parseCloudUrl(url: string, scheme: string, type: BackendType): ParsedBackendUrl {
  // s3://bucket/prefix/ or gs://bucket/prefix/ or azure://container/prefix/
  const afterScheme = url.slice(scheme.length + 1); // skip "s3://" -> after "//"
  if (!afterScheme || !url.includes('://')) {
    throw new ValidationError(`Invalid ${scheme} URL format: ${url}`, [
      `Expected format: ${scheme}//bucket/prefix/`,
    ]);
  }

  const pathPart = url.slice(url.indexOf('://') + 3);
  const slashIndex = pathPart.indexOf('/');

  if (slashIndex === -1 || slashIndex === pathPart.length - 1) {
    const bucket = slashIndex === -1 ? pathPart : pathPart.slice(0, slashIndex);
    if (slashIndex === -1) {
      throw new ValidationError(`${scheme} URL requires a prefix after the bucket: ${url}`, [
        `Example: ${scheme}//${bucket}/my-prefix/`,
      ]);
    }
    throw new ValidationError(`${scheme} URL requires a non-empty prefix: ${url}`, [
      `Example: ${scheme}//${bucket}/my-prefix/`,
    ]);
  }

  const bucket = pathPart.slice(0, slashIndex);
  let prefix = pathPart.slice(slashIndex + 1);

  validateBucketName(bucket, type, url);
  validatePrefix(prefix, url);

  // Normalize trailing slash
  if (!prefix.endsWith('/')) {
    prefix += '/';
  }

  return { type, bucket, prefix, originalUrl: url };
}

function parseLocalUrl(url: string): ParsedBackendUrl {
  const path = url.slice('local:'.length);
  if (!path || path.trim().length === 0) {
    throw new ValidationError('local: URL requires a path.', [
      'Example: local:../blobsy-remote',
      'Example: local:~/blobsy-storage',
    ]);
  }

  return { type: 'local', path, originalUrl: url };
}

function validateBucketName(bucket: string, _type: BackendType, url: string): void {
  if (bucket.length < MIN_BUCKET_NAME_LENGTH || bucket.length > MAX_BUCKET_NAME_LENGTH) {
    throw new ValidationError(
      `Bucket name must be ${MIN_BUCKET_NAME_LENGTH}-${MAX_BUCKET_NAME_LENGTH} characters: "${bucket}" in ${url}`,
    );
  }

  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    throw new ValidationError(
      `Invalid bucket name: "${bucket}". Must be lowercase alphanumeric with hyphens/periods, no leading/trailing hyphen.`,
    );
  }
}

function validatePrefix(prefix: string, url: string): void {
  if (prefix.startsWith('/')) {
    throw new ValidationError(`Prefix must not start with '/': ${url}`);
  }
  if (prefix.includes('//')) {
    throw new ValidationError(`Prefix must not contain '//': ${url}`);
  }
  if (prefix.includes('\\')) {
    throw new ValidationError(`Prefix must not contain backslashes: ${url}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(prefix)) {
    throw new ValidationError(`Prefix must not contain control characters: ${url}`);
  }
}

/** Validate a parsed backend URL against the repo context. */
export function validateBackendUrl(parsed: ParsedBackendUrl, repoRoot: string): void {
  if (parsed.type === 'local' && parsed.path) {
    const resolvedPath = resolveLocalPath(parsed.path, repoRoot);
    if (resolvedPath.startsWith(repoRoot)) {
      throw new ValidationError(
        `Local backend path must be outside the git repository: ${parsed.path}`,
        [`The path "${resolvedPath}" is inside the repo root "${repoRoot}".`],
      );
    }
  }
}

/** Resolve a local backend path relative to repo root, with tilde expansion. */
export function resolveLocalPath(localPath: string, repoRoot: string): string {
  if (localPath === '~') {
    return homedir();
  }
  if (localPath.startsWith('~/')) {
    return resolve(homedir(), localPath.slice(2));
  }
  return resolve(repoRoot, localPath);
}

/** Format a parsed backend URL as a display string. */
export function formatBackendUrl(parsed: ParsedBackendUrl): string {
  return parsed.originalUrl;
}

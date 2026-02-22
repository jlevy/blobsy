/**
 * Content hashing via SHA-256 streaming.
 *
 * Hash is always of original file content (before compression), formatted
 * as "sha256:<64-char-lowercase-hex>".
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Prefix for formatted hash strings (identifies algorithm) */
const HASH_PREFIX = 'sha256:';

/** Stream a file through SHA-256 and return formatted hash. */
export async function computeHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve(formatHash(hash.digest('hex')));
    });
    stream.on('error', reject);
  });
}

/** Hash a string (used by stat cache path computation). */
export function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Format a raw hex digest as "sha256:<hex>". */
export function formatHash(hexDigest: string): string {
  return `${HASH_PREFIX}${hexDigest.toLowerCase()}`;
}

/** Extract the raw hex digest from a formatted hash string. */
export function parseHash(hash: string): string {
  if (!hash.startsWith(HASH_PREFIX)) {
    throw new Error(`Invalid hash format (expected ${HASH_PREFIX}...): ${hash}`);
  }
  return hash.slice(HASH_PREFIX.length);
}

/** Check if a string is a valid formatted hash. */
export function isValidHash(hash: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(hash);
}

/**
 * Key template evaluation.
 *
 * Evaluate remote key templates using variables like {iso_date_secs},
 * {content_sha256}, {repo_path}, etc. Called during push to set remote_key.
 */

import { basename, dirname } from 'node:path';

import { parseHash } from './hash.js';
import { normalizePath } from './paths.js';

export interface TemplateVars {
  hash: string;
  repoPath: string;
  compressSuffix: string;
  timestamp?: Date;
}

/** Evaluate a key template with the given variables. */
export function evaluateTemplate(template: string, vars: TemplateVars): string {
  const hexHash = parseHash(vars.hash);
  const shortHash = hexHash.substring(0, 12);
  const ts = vars.timestamp ?? new Date();
  const isoDateSecs = formatIsoDateSecs(ts);
  const repoPath = normalizePath(vars.repoPath);
  const filename = basename(repoPath);
  const dir = normalizePath(dirname(repoPath));
  const dirWithSlash = dir === '.' ? '' : dir.endsWith('/') ? dir : `${dir}/`;

  const replacements: Record<string, string> = {
    iso_date_secs: isoDateSecs,
    content_sha256: hexHash,
    content_sha256_short: shortHash,
    repo_path: repoPath,
    filename: filename,
    dirname: dirWithSlash,
    compress_suffix: vars.compressSuffix,
  };

  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (key in replacements) {
      return replacements[key]!;
    }
    console.warn(`Warning: unknown template variable {${key}} in key template`);
    return `{${key}}`;
  });
}

/** Format a Date as YYYYMMDDTHHMMSSZ (no punctuation). */
export function formatIsoDateSecs(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${h}${min}${s}Z`;
}

/** Get the compression suffix for a given algorithm. */
export function getCompressSuffix(algorithm: string | undefined): string {
  switch (algorithm) {
    case 'zstd':
      return '.zst';
    case 'gzip':
      return '.gz';
    case 'brotli':
      return '.br';
    default:
      return '';
  }
}

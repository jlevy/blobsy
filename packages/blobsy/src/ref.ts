/**
 * .bref file I/O.
 *
 * Parse and serialize .bref files with self-documenting comment header,
 * stable field ordering, and atomic writes.
 */

import { readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';

import { writeFile } from 'atomically';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { Bref } from './types.js';
import {
  BREF_COMMENT_HEADER,
  BREF_FIELD_ORDER,
  BREF_FORMAT,
  ValidationError,
  UserError,
} from './types.js';
import { ensureDir } from './fs-utils.js';
import { brefSchema, formatSchemaIssues, hasConflictMarkers } from './config-schema.js';

/** Parse a .bref file, validate format version. */
export async function readBref(path: string): Promise<Bref> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      const fileName = basename(path, '.bref');
      throw new UserError(`File not tracked: ${fileName}`, `Run: blobsy track ${fileName}`);
    }

    if (error.code === 'EACCES') {
      throw new UserError(
        `Permission denied reading .bref file: ${path}`,
        `Check file permissions: chmod +r ${path}`,
      );
    }

    // Unexpected error - re-throw as ValidationError
    throw new ValidationError(`Cannot read .bref file: ${path}: ${error.message}`);
  }

  // A conflicted git pull leaves marker lines that YAML-parse into
  // gibberish; report the real problem directly (review finding CFG-03).
  if (hasConflictMarkers(content)) {
    throw new UserError(
      `Unresolved merge conflict markers in .bref file: ${path}`,
      'Resolve the git conflict (look for <<<<<<< / >>>>>>> lines) and retry.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (_err: unknown) {
    const fileName = basename(path);
    throw new UserError(
      `Invalid .bref file format: ${fileName}`,
      `File may be corrupted. Regenerate with: blobsy track --force ${basename(fileName, '.bref')}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(`Invalid .bref file (not an object): ${path}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.format !== 'string') {
    throw new ValidationError(`Missing or invalid 'format' field in .bref file: ${path}`);
  }

  validateFormatVersion(obj.format, path);

  // Schema validation (review finding CFG-03): field-level type errors are
  // reported with the offending key instead of surfacing later.
  const result = brefSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(`Invalid .bref file: ${path}: ${formatSchemaIssues(result.error)}`);
  }

  const bref = result.data;
  return {
    format: bref.format,
    hash: bref.hash,
    size: bref.size,
    remote_key: bref.remote_key,
    compressed: bref.compressed,
    compressed_size: bref.compressed_size,
  };
}

/** Write a .bref file with comment header, stable field ordering, and atomic write. */
export async function writeBref(path: string, ref: Bref): Promise<void> {
  await ensureDir(dirname(path));

  const ordered: Record<string, unknown> = {};
  for (const key of BREF_FIELD_ORDER) {
    const value = ref[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }

  const yamlContent = stringifyYaml(ordered, { lineWidth: 0 });
  const content = BREF_COMMENT_HEADER + yamlContent;
  await writeFile(path, content);
}

/**
 * Validate the format version string.
 *
 * Reject unsupported major versions; warn on newer minor versions.
 * Expected format: "blobsy-bref/MAJOR.MINOR"
 */
export function validateFormatVersion(format: string, filePath?: string): void {
  const prefix = 'blobsy-bref/';
  if (!format.startsWith(prefix)) {
    throw new ValidationError(
      `Unsupported .bref format: ${format}${filePath ? ` in ${filePath}` : ''}`,
      [`Expected format starting with '${prefix}'.`],
    );
  }

  const versionStr = format.slice(prefix.length);
  const parts = versionStr.split('.');
  if (parts.length !== 2) {
    throw new ValidationError(
      `Invalid format version: ${format}${filePath ? ` in ${filePath}` : ''}`,
    );
  }

  const [majorStr, _minorStr] = parts;
  const currentParts = BREF_FORMAT.slice(prefix.length).split('.');
  const currentMajor = Number(currentParts[0]);
  const major = Number(majorStr);

  if (Number.isNaN(major) || major !== currentMajor) {
    throw new ValidationError(
      `Unsupported .bref major version: ${format} (supported: ${BREF_FORMAT})${filePath ? ` in ${filePath}` : ''}`,
      [`Upgrade blobsy to support this format version.`],
    );
  }
}

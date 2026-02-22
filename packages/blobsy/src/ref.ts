/**
 * .yref file I/O.
 *
 * Parse and serialize .yref files with self-documenting comment header,
 * stable field ordering, and atomic writes.
 */

import { readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';

import { writeFile } from 'atomically';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { YRef } from './types.js';
import {
  YREF_COMMENT_HEADER,
  YREF_FIELD_ORDER,
  YREF_FORMAT,
  ValidationError,
  UserError,
} from './types.js';
import { ensureDir } from './fs-utils.js';

/** Parse a .yref file, validate format version. */
export async function readYRef(path: string): Promise<YRef> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      const fileName = basename(path, '.yref');
      throw new UserError(`File not tracked: ${fileName}`, `Run: blobsy track ${fileName}`);
    }

    if (error.code === 'EACCES') {
      throw new UserError(
        `Permission denied reading .yref file: ${path}`,
        `Check file permissions: chmod +r ${path}`,
      );
    }

    // Unexpected error - re-throw as ValidationError
    throw new ValidationError(`Cannot read .yref file: ${path}: ${error.message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (_err: unknown) {
    const fileName = basename(path);
    throw new UserError(
      `Invalid .yref file format: ${fileName}`,
      `File may be corrupted. Regenerate with: blobsy track --force ${basename(fileName, '.yref')}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ValidationError(`Invalid .yref file (not an object): ${path}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.format !== 'string') {
    throw new ValidationError(`Missing or invalid 'format' field in .yref file: ${path}`);
  }

  validateFormatVersion(obj.format, path);

  if (typeof obj.hash !== 'string') {
    throw new ValidationError(`Missing or invalid 'hash' field in .yref file: ${path}`);
  }

  if (typeof obj.size !== 'number') {
    throw new ValidationError(`Missing or invalid 'size' field in .yref file: ${path}`);
  }

  return {
    format: obj.format,
    hash: obj.hash,
    size: obj.size,
    remote_key: typeof obj.remote_key === 'string' ? obj.remote_key : undefined,
    compressed: typeof obj.compressed === 'string' ? obj.compressed : undefined,
    compressed_size: typeof obj.compressed_size === 'number' ? obj.compressed_size : undefined,
  };
}

/** Write a .yref file with comment header, stable field ordering, and atomic write. */
export async function writeYRef(path: string, ref: YRef): Promise<void> {
  await ensureDir(dirname(path));

  const ordered: Record<string, unknown> = {};
  for (const key of YREF_FIELD_ORDER) {
    const value = ref[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }

  const yamlContent = stringifyYaml(ordered, { lineWidth: 0 });
  const content = YREF_COMMENT_HEADER + yamlContent;
  await writeFile(path, content);
}

/**
 * Validate the format version string.
 *
 * Reject unsupported major versions; warn on newer minor versions.
 * Expected format: "blobsy-yref/MAJOR.MINOR"
 */
export function validateFormatVersion(format: string, filePath?: string): void {
  const prefix = 'blobsy-yref/';
  if (!format.startsWith(prefix)) {
    throw new ValidationError(
      `Unsupported .yref format: ${format}${filePath ? ` in ${filePath}` : ''}`,
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
  const currentParts = YREF_FORMAT.slice(prefix.length).split('.');
  const currentMajor = Number(currentParts[0]);
  const major = Number(majorStr);

  if (Number.isNaN(major) || major !== currentMajor) {
    throw new ValidationError(
      `Unsupported .yref major version: ${format} (supported: ${YREF_FORMAT})${filePath ? ` in ${filePath}` : ''}`,
      [`Upgrade blobsy to support this format version.`],
    );
  }
}

/**
 * Schema validation for .blobsy.yml and .bref files (review finding CFG-03).
 *
 * Parsed YAML used to be cast directly to config/bref types, so a value like
 * `externalize.min_size: true` only surfaced much later as a confusing
 * parseSize error. Zod validation reports the offending key and expected
 * type at load time. Unknown keys are intentionally allowed here — doctor
 * reports them with did-you-mean suggestions instead of hard-failing.
 */

import { z } from 'zod';

/** Human-readable size ("200kb") or raw byte count. */
const sizeSchema = z.union([z.string(), z.number()], {
  error: 'expected a size string (e.g. "200kb") or a number of bytes',
});

/**
 * Glob pattern list. A single string is also accepted: `blobsy config
 * externalize.never "*.md"` stores a scalar, and the matcher (picomatch)
 * handles both forms.
 */
const patternListSchema = z.union([z.array(z.string()), z.string()], {
  error: 'expected a glob pattern or a list of glob patterns',
});

const externalizeSchema = z.object({
  min_size: sizeSchema.optional(),
  always: patternListSchema.optional(),
  never: patternListSchema.optional(),
});

const compressSchema = z.object({
  min_size: sizeSchema.optional(),
  // Plain string, not an enum: doctor reports unknown algorithms as a
  // warning with context; a load-time hard fail would keep doctor from
  // diagnosing the config at all.
  algorithm: z.string().optional(),
  always: patternListSchema.optional(),
  never: patternListSchema.optional(),
});

const backendSchema = z.object({
  type: z.enum(['s3', 'gcs', 'azure', 'local', 'command']).optional(),
  url: z.string().optional(),
  bucket: z.string().optional(),
  prefix: z.string().optional(),
  path: z.string().optional(),
  region: z.string().optional(),
  endpoint: z.string().optional(),
  push_command: z.string().optional(),
  pull_command: z.string().optional(),
  exists_command: z.string().optional(),
  rclone_remote: z.string().optional(),
});

export const blobsyConfigSchema = z.object({
  backend: z.string().optional(),
  backends: z.record(z.string(), backendSchema).optional(),
  externalize: externalizeSchema.optional(),
  compress: compressSchema.optional(),
  ignore: patternListSchema.optional(),
  remote: z.object({ key_template: z.string().optional() }).optional(),
  sync: z.object({ tools: z.array(z.string()).optional() }).optional(),
  checksum: z.object({ algorithm: z.string().optional() }).optional(),
  /** Out-of-repo trust grant for command backends (user-global config only). */
  trust_command_backends: z.union([z.boolean(), z.array(z.string())]).optional(),
});

export const brefSchema = z.object({
  format: z.string(),
  hash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'expected "sha256:" followed by 64 lowercase hex chars'),
  size: z.number().int().nonnegative(),
  remote_key: z.string().optional(),
  compressed: z.string().optional(),
  compressed_size: z.number().int().nonnegative().optional(),
});

/**
 * Format a ZodError as a short human-readable list of problems.
 * ("externalize.min_size: expected a size string ... ")
 */
export function formatSchemaIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

/**
 * Detect unresolved git merge conflict markers.
 *
 * A conflicted file always contains a line starting with `<<<<<<<`; a
 * cryptic YAML parse error after a conflicted pull is much harder to act
 * on than a direct message (review finding CFG-03).
 */
export function hasConflictMarkers(content: string): boolean {
  return /^(<{7}|>{7})(\s|$)/m.test(content);
}

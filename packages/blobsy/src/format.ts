/**
 * Output formatting for CLI display.
 *
 * State symbols, human-readable sizes, status tables, JSON envelopes,
 * and structured error formatting.
 */

import type { BlobsyError, FileStateSymbol, TransferResult } from './types.js';
import { FILE_STATE_SYMBOLS } from './types.js';

/** JSON schema version for blobsy output */
const SCHEMA_VERSION = '0.1';

/** Bytes per kilobyte (base-2) */
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

/** Threshold for showing one decimal place in size formatting */
const SIZE_DECIMAL_THRESHOLD = 10;

/** Format a file state line for status output. */
export function formatFileState(symbol: FileStateSymbol, path: string, details: string): string {
  return `  ${symbol}  ${path}  ${details}`;
}

/** Format bytes as human-readable size (B, KB, MB, GB). */
export function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) {
    return `${bytes} B`;
  }
  if (bytes < BYTES_PER_MB) {
    const kb = bytes / BYTES_PER_KB;
    return kb >= SIZE_DECIMAL_THRESHOLD ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
  }
  if (bytes < BYTES_PER_GB) {
    const mb = bytes / BYTES_PER_MB;
    return mb >= SIZE_DECIMAL_THRESHOLD ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  }
  const gb = bytes / BYTES_PER_GB;
  return gb >= SIZE_DECIMAL_THRESHOLD ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** Wrap data in a JSON envelope with schema_version. */
export function formatJson(data: unknown): string {
  const envelope = {
    schema_version: SCHEMA_VERSION,
    ...(typeof data === 'object' && data !== null ? data : { data }),
  };
  return JSON.stringify(envelope, null, 2);
}

/** Format a simple message as JSON. */
export function formatJsonMessage(
  message: string,
  level: 'info' | 'debug' | 'warning' = 'info',
): string {
  return formatJson({ message, level });
}

/** Format an error as JSON. */
export function formatJsonError(error: BlobsyError | Error): string {
  if ('category' in error) {
    const blobsyError = error;
    return formatJson({
      error: blobsyError.message,
      type: blobsyError.category,
      ...(blobsyError.suggestions ? { suggestions: blobsyError.suggestions } : {}),
    });
  }
  return formatJson({ error: error.message, type: 'unknown' });
}

/** Format a transfer summary (push/pull results). */
export function formatTransferSummary(results: TransferResult[]): string {
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const lines: string[] = [];

  for (const r of succeeded) {
    lines.push(
      r.action === 'push'
        ? formatPushResult(r.path, r.bytesTransferred)
        : formatPullResult(r.path, r.bytesTransferred),
    );
  }

  for (const r of failed) {
    lines.push(formatTransferFail(r.path, r.error ?? 'unknown error'));
  }

  if (succeeded.length > 0 || failed.length > 0) {
    lines.push('');
    const parts: string[] = [];
    if (succeeded.length > 0) {
      parts.push(`${succeeded.length} succeeded`);
    }
    if (failed.length > 0) {
      parts.push(`${failed.length} failed`);
    }
    lines.push(parts.join(', '));
  }

  return lines.join('\n');
}

/** Format an error with troubleshooting suggestions. */
export function formatError(error: BlobsyError | Error): string {
  const lines: string[] = [`Error: ${error.message}`];

  if ('suggestions' in error && error.suggestions) {
    lines.push('');
    for (const suggestion of error.suggestions) {
      lines.push(`  ${suggestion}`);
    }
  }

  return lines.join('\n');
}

/** Format a dry-run action message. */
export function formatDryRun(action: string): string {
  return `Would ${action}`;
}

/** Format dry-run actions as JSON. */
export function formatJsonDryRun(actions: string[]): string {
  return formatJson({ dry_run: true, actions });
}

// --- Semantic output symbols ---

/** Centralized symbols for diagnostic and transfer output. */
export const OUTPUT_SYMBOLS = {
  pass: '\u2713', // ✓
  fail: '\u2717', // ✗
  warn: '\u26A0', // ⚠
  info: '\u2139', // ℹ
  push: '\u2191', // ↑
  pull: '\u2193', // ↓
} as const;

// --- Section headings ---

/** Format a section heading: "=== NAME ===" */
export function formatHeading(name: string): string {
  return `=== ${name.toUpperCase()} ===`;
}

// --- Diagnostic check results (for doctor) ---

/** Format a passing check: "  ✓  message" */
export function formatCheckPass(message: string): string {
  return `  ${OUTPUT_SYMBOLS.pass}  ${message}`;
}

/** Format a failing check: "  ✗  message" */
export function formatCheckFail(message: string): string {
  return `  ${OUTPUT_SYMBOLS.fail}  ${message}`;
}

/** Format a warning check: "  ⚠  message" */
export function formatCheckWarn(message: string): string {
  return `  ${OUTPUT_SYMBOLS.warn}  ${message}`;
}

/** Format an info check: "  ℹ  message" */
export function formatCheckInfo(message: string): string {
  return `  ${OUTPUT_SYMBOLS.info}  ${message}`;
}

/** Format a fixed issue: "  ✓ Fixed  message" */
export function formatCheckFixed(message: string): string {
  return `  ${OUTPUT_SYMBOLS.pass} Fixed  ${message}`;
}

// --- Transfer results (for push/pull/sync) ---

/** Format a single push result: "  ↑  path (size)" */
export function formatPushResult(path: string, size?: number): string {
  const sizeStr = size != null ? ` (${formatSize(size)})` : '';
  return `  ${OUTPUT_SYMBOLS.push}  ${path}${sizeStr}`;
}

/** Format a single pull result: "  ↓  path (size)" */
export function formatPullResult(path: string, size?: number): string {
  const sizeStr = size != null ? ` (${formatSize(size)})` : '';
  return `  ${OUTPUT_SYMBOLS.pull}  ${path}${sizeStr}`;
}

/** Format a transfer failure: "  ✗  path - FAILED: error" */
export function formatTransferFail(path: string, error: string): string {
  return `  ${OUTPUT_SYMBOLS.fail}  ${path} - FAILED: ${error}`;
}

// --- Summaries ---

/** Pluralize: "1 file" / "3 files". Custom plural form optional. */
export function formatCount(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

// --- Informational messages ---

/** Format a warning message: "⚠  message" */
export function formatWarning(message: string): string {
  return `${OUTPUT_SYMBOLS.warn}  ${message}`;
}

/** Format a note/hint: "  hint text" */
export function formatHint(hint: string): string {
  return `  ${hint}`;
}

export { FILE_STATE_SYMBOLS, SCHEMA_VERSION };

/**
 * Output formatting for CLI display.
 *
 * State symbols, human-readable sizes, status tables, JSON envelopes,
 * structured error formatting, and semantic coloring via picocolors.
 *
 * Colors are automatically disabled when output is piped (non-TTY),
 * when NO_COLOR is set, or via the --color never flag.
 */

import colors, { createColors } from 'picocolors';

import type { BlobsyError, FileStateSymbol, TransferResult } from './types.js';
import { FILE_STATE_SYMBOLS } from './types.js';

/** JSON schema version for blobsy output */
const SCHEMA_VERSION = '0.1';

/** Threshold for showing one decimal place in size formatting */
const SIZE_DECIMAL_THRESHOLD = 10;

// --- Semantic color map ---

type ColorFn = (s: string | number) => string;

/** Semantic color wrappers for CLI output. */
export const c: {
  success: ColorFn;
  error: ColorFn;
  warning: ColorFn;
  info: ColorFn;
  command: ColorFn;
  heading: ColorFn;
  hint: ColorFn;
  muted: ColorFn;
} = {
  success: colors.green,
  error: colors.red,
  warning: colors.yellow,
  info: colors.cyan,
  command: colors.bold,
  heading: colors.bold,
  hint: colors.dim,
  muted: colors.gray,
};

/**
 * Re-initialize the semantic color map with explicit color mode.
 * Call this after parsing the --color flag, before any output.
 */
export function initColors(mode: 'always' | 'never' | 'auto'): void {
  if (mode === 'auto') {
    return; // Use picocolors default detection
  }
  const pc = createColors(mode === 'always');
  c.success = pc.green;
  c.error = pc.red;
  c.warning = pc.yellow;
  c.info = pc.cyan;
  c.command = pc.bold;
  c.heading = pc.bold;
  c.hint = pc.dim;
  c.muted = pc.gray;
}

/** Format a file state line for status output. */
export function formatFileState(
  symbol: FileStateSymbol,
  path: string,
  details: string,
  size?: number,
): string {
  const sizeStr = size != null ? ` (${formatSize(size)})` : '';
  return `  ${symbol}  ${path}  ${details}${sizeStr}`;
}

/** Format bytes as human-readable size (B, KB, MB, GB). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return kb >= SIZE_DECIMAL_THRESHOLD ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return mb >= SIZE_DECIMAL_THRESHOLD ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
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
  const lines: string[] = [c.error(`Error: ${error.message}`)];

  if ('suggestions' in error && error.suggestions) {
    lines.push('');
    for (const suggestion of error.suggestions) {
      lines.push(c.hint(`  ${suggestion}`));
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
  pass: '✓',
  fail: '✗',
  warn: '⚠',
  info: 'ℹ',
  push: '↑',
  pull: '↓',
} as const;

// --- Section headings ---

/** Format a section heading: "=== NAME ===" */
export function formatHeading(name: string): string {
  return c.heading(`=== ${name.toUpperCase()} ===`);
}

// --- Diagnostic check results (for doctor) ---

/** Format a passing check: "  ✓  message" */
export function formatCheckPass(message: string): string {
  return `  ${c.success(OUTPUT_SYMBOLS.pass)}  ${message}`;
}

/** Format a failing check: "  ✗  message" */
export function formatCheckFail(message: string): string {
  return `  ${c.error(OUTPUT_SYMBOLS.fail)}  ${message}`;
}

/** Format a warning check: "  ⚠  message" */
export function formatCheckWarn(message: string): string {
  return `  ${c.warning(OUTPUT_SYMBOLS.warn)}  ${message}`;
}

/** Format an info check: "  ℹ  message" */
export function formatCheckInfo(message: string): string {
  return `  ${c.info(OUTPUT_SYMBOLS.info)}  ${message}`;
}

/** Format a fixed issue: "  ✓ Fixed  message" */
export function formatCheckFixed(message: string): string {
  return `  ${c.success(OUTPUT_SYMBOLS.pass + ' Fixed')}  ${message}`;
}

// --- Transfer results (for push/pull/sync) ---

/** Format a single push result: "  ↑  path (size)" */
export function formatPushResult(path: string, size?: number): string {
  const sizeStr = size != null ? ` (${formatSize(size)})` : '';
  return `  ${c.success(OUTPUT_SYMBOLS.push)}  ${path}${sizeStr}`;
}

/** Format a single pull result: "  ↓  path (size)" */
export function formatPullResult(path: string, size?: number): string {
  const sizeStr = size != null ? ` (${formatSize(size)})` : '';
  return `  ${c.success(OUTPUT_SYMBOLS.pull)}  ${path}${sizeStr}`;
}

/** Format a transfer failure: "  ✗  path - FAILED: error" */
export function formatTransferFail(path: string, error: string): string {
  return `  ${c.error(OUTPUT_SYMBOLS.fail)}  ${path} - ${c.error('FAILED: ' + error)}`;
}

// --- Summaries ---

/** Pluralize: "1 file" / "3 files". Custom plural form optional. */
export function formatCount(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

// --- Informational messages ---

/** Format a warning message: "⚠  message" */
export function formatWarning(message: string): string {
  return `${c.warning(OUTPUT_SYMBOLS.warn)}  ${c.warning(message)}`;
}

/** Format a note/hint: "  hint text" */
export function formatHint(hint: string): string {
  return c.hint(`  ${hint}`);
}

// --- New semantic helpers ---

/** Format an info/status message with color. */
export function formatInfo(message: string): string {
  return c.info(message);
}

/** Format a success/completion message with color. */
export function formatSuccess(message: string): string {
  return c.success(message);
}

/** Format a CLI command reference with bold. */
export function formatCommand(command: string): string {
  return c.command(command);
}

/** Format a "next steps" block: heading + indented step list. */
export function formatNextSteps(heading: string, steps: { cmd: string; desc: string }[]): string {
  const lines: string[] = [heading];
  for (const step of steps) {
    lines.push(`  ${c.command(step.cmd)}    ${step.desc}`);
  }
  return lines.join('\n');
}

export { FILE_STATE_SYMBOLS, SCHEMA_VERSION };

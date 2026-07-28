/**
 * Hermetic CLI harness: always runs the CLI built from THIS checkout.
 *
 * Tests must never resolve `blobsy` from PATH — a globally linked binary can
 * silently substitute a stale or unrelated build and produce a false green
 * (review finding DX-01). The one exception is code that re-invokes blobsy
 * internally (git hook shims), which is exercised via the absolute argv[1]
 * path the CLI detects at install time.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa, type Options } from 'execa';

/** Absolute path to the CLI entry point built from this checkout. */
export const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'cli.mjs',
);

if (!existsSync(CLI_PATH)) {
  throw new Error(`Built CLI not found at ${CLI_PATH}. Run "pnpm build" before testing.`);
}

/** Run the checkout-built blobsy CLI (never a PATH-resolved binary). */
export function blobsy<T extends Options = Record<never, never>>(
  args: readonly string[],
  options?: T,
) {
  // Ambient BLOBSY_NO_HOOKS (set by some CI/sandbox environments) would
  // silently change hook-install behavior; clear it unless a test opts in.
  const merged = {
    ...options,
    env: { BLOBSY_NO_HOOKS: '', ...options?.env },
  } as unknown as T;
  return execa(process.execPath, [CLI_PATH, ...args], merged);
}

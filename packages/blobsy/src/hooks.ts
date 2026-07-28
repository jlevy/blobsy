/**
 * Git hook installation shared by init/setup and `blobsy hooks install`.
 *
 * Single source of truth for hook script content, ownership checks, and
 * hooks-directory resolution — previously two divergent installers lived in
 * cli.ts and commands-stage2.ts (review finding HK-02).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { HOOK_MANAGED_MARKER } from './types.js';
import { ensureDir } from './fs-utils.js';

export const HOOK_TYPES = [
  { name: 'pre-commit', gitEvent: 'pre-commit', bypassCmd: 'git commit --no-verify' },
  { name: 'pre-push', gitEvent: 'pre-push', bypassCmd: 'git push --no-verify' },
] as const;

export type HookType = (typeof HOOK_TYPES)[number];

/** True when the user has opted out of git hooks via BLOBSY_NO_HOOKS. */
export function hooksDisabledByEnv(): boolean {
  return Boolean(process.env.BLOBSY_NO_HOOKS);
}

/**
 * Resolve the active hooks directory for this checkout.
 *
 * `join(repoRoot, '.git', 'hooks')` is wrong in linked worktrees (where
 * .git is a file) and when core.hooksPath is set — hooks silently landed
 * in a directory git never consults (review finding HK-04). `git rev-parse
 * --git-path hooks` handles both.
 */
export function gitHooksDir(repoRoot: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return isAbsolute(out) ? out : resolve(repoRoot, out);
  } catch {
    return join(repoRoot, '.git', 'hooks');
  }
}

/** Detect the path to the blobsy executable for use inside hook scripts. */
export function detectBlobsyPath(): string {
  const execPath = process.argv[1];
  if (execPath && isAbsolute(execPath)) {
    return execPath;
  }
  try {
    return execFileSync('which', ['blobsy'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'blobsy';
  }
}

/**
 * True when installHook would write this hook: no hook file exists yet, or
 * the existing file carries the blobsy managed marker. Lets dry-run report
 * exactly what the real installer would do.
 */
export async function wouldInstallHook(repoRoot: string, hook: HookType): Promise<boolean> {
  const hookPath = join(gitHooksDir(repoRoot), hook.name);
  if (!existsSync(hookPath)) {
    return true;
  }
  const existing = await readFile(hookPath, 'utf-8');
  return existing.includes(HOOK_MANAGED_MARKER);
}

/**
 * Install a single git hook.
 *
 * Returns false (without touching the file) when a hook exists that blobsy
 * does not own — identified by the exact managed marker. Overwriting a
 * user's hook silently removes their linters/tests/signing (review finding
 * HK-03); "the file mentions blobsy" is not ownership.
 */
export async function installHook(repoRoot: string, hook: HookType): Promise<boolean> {
  const hookDir = gitHooksDir(repoRoot);
  await ensureDir(hookDir);
  const blobsyPath = detectBlobsyPath();
  const hookPath = join(hookDir, hook.name);

  if (!(await wouldInstallHook(repoRoot, hook))) {
    return false;
  }

  const hookContent = `#!/bin/sh
${HOOK_MANAGED_MARKER}
# To bypass: ${hook.bypassCmd}
exec "${blobsyPath}" hook ${hook.gitEvent}
`;
  await writeFile(hookPath, hookContent);
  await chmod(hookPath, 0o755);
  return true;
}

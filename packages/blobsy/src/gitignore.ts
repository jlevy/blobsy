/**
 * Gitignore management.
 *
 * Add/remove entries within a blobsy-managed block in per-directory .gitignore files.
 * Entries are paths relative to the .gitignore file's directory.
 *
 * Also handles gitignore conflict detection and correction: when files to be staged
 * are inside a gitignored directory, the directory pattern is rewritten to a glob
 * pattern with negation rules that allow .bref and .gitignore files.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { writeFile } from 'atomically';

/** Start marker for blobsy-managed block in .gitignore files */
const BLOCK_START = '# >>> blobsy-managed (do not edit) >>>';

/** End marker for blobsy-managed block in .gitignore files */
const BLOCK_END = '# <<< blobsy-managed <<<';

/** Add a file entry to the blobsy-managed block in a directory's .gitignore. */
export async function addGitignoreEntry(directory: string, relativeName: string): Promise<void> {
  const gitignorePath = join(directory, '.gitignore');
  const entries = await readBlobsyBlock(gitignorePath);

  if (!entries.includes(relativeName)) {
    entries.push(relativeName);
  }

  await writeBlobsyBlock(gitignorePath, entries);
}

/** Remove a file entry from the blobsy-managed block. */
export async function removeGitignoreEntry(directory: string, relativeName: string): Promise<void> {
  const gitignorePath = join(directory, '.gitignore');
  const entries = await readBlobsyBlock(gitignorePath);

  const filtered = entries.filter((e) => e !== relativeName);
  await writeBlobsyBlock(gitignorePath, filtered);
}

/** Read the entries inside the blobsy-managed block. */
export async function readBlobsyBlock(gitignorePath: string): Promise<string[]> {
  if (!existsSync(gitignorePath)) {
    return [];
  }

  const content = await readFile(gitignorePath, 'utf-8');
  const lines = content.split('\n');

  let inBlock = false;
  const entries: string[] = [];

  for (const line of lines) {
    if (line.trim() === BLOCK_START) {
      inBlock = true;
      continue;
    }
    if (line.trim() === BLOCK_END) {
      inBlock = false;
      continue;
    }
    if (inBlock) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        entries.push(trimmed);
      }
    }
  }

  return entries;
}

/**
 * Write the blobsy-managed block in a .gitignore file.
 *
 * Preserves any non-blobsy content. Entries are sorted and deduped.
 */
export async function writeBlobsyBlock(gitignorePath: string, entries: string[]): Promise<void> {
  const deduped = [...new Set(entries)].sort();

  let existingContent = '';
  if (existsSync(gitignorePath)) {
    existingContent = await readFile(gitignorePath, 'utf-8');
  }

  const blockContent = [BLOCK_START, ...deduped, BLOCK_END].join('\n');

  if (existingContent.includes(BLOCK_START)) {
    // Replace existing block
    const beforeBlock = existingContent.slice(0, existingContent.indexOf(BLOCK_START));
    const afterBlockEnd = existingContent.indexOf(BLOCK_END);
    const afterBlock =
      afterBlockEnd >= 0 ? existingContent.slice(afterBlockEnd + BLOCK_END.length) : '';

    const newContent = beforeBlock + blockContent + afterBlock;
    await writeFile(gitignorePath, newContent);
  } else {
    // Append new block
    const separator = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
    await writeFile(gitignorePath, existingContent + separator + blockContent + '\n');
  }
}

// --- Gitignore conflict detection and correction ---

/** Result of a git check-ignore -v call for a single file. */
interface GitignoreConflict {
  /** Path to the .gitignore file containing the rule */
  gitignorePath: string;
  /** Line number (1-based) in the .gitignore file */
  lineNumber: number;
  /** The original pattern that matched */
  pattern: string;
  /** The file path that was checked */
  filePath: string;
}

/**
 * Detect gitignore conflicts for files that need to be staged.
 *
 * Uses `git check-ignore -v` to find which gitignore rules would block
 * `git add` for the given files. Returns conflict info for each blocked file,
 * deduplicated by source rule.
 */
export function detectGitignoreConflicts(
  filePaths: string[],
  repoRoot: string,
): GitignoreConflict[] {
  if (filePaths.length === 0) {
    return [];
  }

  // Use repo-relative paths for git check-ignore
  const relPaths = filePaths.map((f) => relative(repoRoot, f));

  let output: string;
  try {
    output = execFileSync('git', ['check-ignore', '-v', '--', ...relPaths], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    // git check-ignore exits with 1 when no files are ignored
    const execErr = err as { status?: number; stdout?: string };
    if (execErr.status === 1) {
      return [];
    }
    // Other exit codes (128 for fatal errors) should propagate
    throw err;
  }

  // Parse output: each line is "<gitignore>:<linenum>:<pattern>\t<pathname>"
  const conflicts: GitignoreConflict[] = [];
  const seenRules = new Set<string>();

  for (const line of output.trim().split('\n')) {
    if (!line) {
      continue;
    }
    // Format: source:linenum:pattern\tpathname
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) {
      continue;
    }
    const source = line.slice(0, tabIdx);
    const filePath = line.slice(tabIdx + 1);

    // source is "gitignorePath:lineNum:pattern"
    const firstColon = source.indexOf(':');
    const secondColon = source.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) {
      continue;
    }

    const gitignorePath = join(repoRoot, source.slice(0, firstColon));
    const lineNumber = parseInt(source.slice(firstColon + 1, secondColon), 10);
    const pattern = source.slice(secondColon + 1).trim();

    // Negation patterns (starting with !) mean the file is NOT ignored — skip
    if (pattern.startsWith('!')) {
      continue;
    }

    // Deduplicate by source rule (same file + line)
    const ruleKey = `${gitignorePath}:${lineNumber}`;
    if (seenRules.has(ruleKey)) {
      continue;
    }
    seenRules.add(ruleKey);

    conflicts.push({ gitignorePath, lineNumber, pattern, filePath });
  }

  return conflicts;
}

/** Comment added before rewritten gitignore rules. */
const REWRITE_COMMENT = '# Directory ignore rewritten by blobsy to allow .bref tracking';

/**
 * Rewrite a directory gitignore pattern to allow .bref and .gitignore files.
 *
 * Transforms patterns like:
 *   `data/`  -> `data/**` + negation rules
 *   `data`   -> `data/**` + negation rules
 *   `data/**` -> adds negation rules only
 *
 * The negation rules allow .bref files and per-directory .gitignore files
 * to be staged while keeping the original blobs ignored.
 */
export async function fixGitignoreForBlobsy(
  gitignorePath: string,
  lineNumber: number,
  pattern: string,
): Promise<void> {
  if (!existsSync(gitignorePath)) {
    return;
  }

  const content = await readFile(gitignorePath, 'utf-8');
  const lines = content.split('\n');

  // Find the line with the pattern (1-based to 0-based)
  const lineIdx = lineNumber - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) {
    return;
  }

  // Check if this line is inside the blobsy-managed block — skip if so
  let inBlock = false;
  for (let i = 0; i < lineIdx; i++) {
    if (lines[i]!.trim() === BLOCK_START) {
      inBlock = true;
    }
    if (lines[i]!.trim() === BLOCK_END) {
      inBlock = false;
    }
  }
  if (inBlock) {
    return;
  }

  // Already rewritten? Check if next line has our comment
  if (lineIdx > 0 && lines[lineIdx - 1]?.trim() === REWRITE_COMMENT) {
    return;
  }

  // Determine the base pattern (strip trailing / and leading !)
  const basePattern = pattern.trim();

  // Skip negation patterns
  if (basePattern.startsWith('!')) {
    return;
  }

  // Compute the glob version of the pattern
  let globPattern: string;
  if (basePattern.endsWith('/**')) {
    // Already a glob pattern, just add negation rules
    globPattern = basePattern;
  } else if (basePattern.endsWith('/')) {
    // Directory pattern: data/ -> data/**
    globPattern = basePattern.slice(0, -1) + '/**';
  } else {
    // Bare name or path: data -> data/**
    globPattern = basePattern + '/**';
  }

  // Compute the negation prefix from the glob pattern
  // data/** -> !data/**/  (allow subdirectories to be traversed)
  const negationBase = globPattern.slice(0, -2); // strip trailing **
  const negationDir = `!${negationBase}*/`;

  const replacementLines = [
    REWRITE_COMMENT,
    globPattern,
    negationDir,
    '!**/*.bref',
    '!**/.gitignore',
  ];

  // Replace the original line
  lines.splice(lineIdx, 1, ...replacementLines);

  await writeFile(gitignorePath, lines.join('\n'));
}

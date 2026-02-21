/**
 * Gitignore management.
 *
 * Add/remove entries within a blobsy-managed block in per-directory .gitignore files.
 * Entries are paths relative to the .gitignore file's directory.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFile } from 'atomically';

const BLOCK_START = '# >>> blobsy-managed (do not edit) >>>';
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

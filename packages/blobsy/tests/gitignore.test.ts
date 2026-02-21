import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { addGitignoreEntry, readBlobsyBlock, removeGitignoreEntry } from '../src/gitignore.js';

describe('gitignore', () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'blobsy-gitignore-test-'));
  }

  it('adds entry to new .gitignore', async () => {
    const dir = tmpDir();
    await addGitignoreEntry(dir, 'model.bin');

    const content = await readFile(join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('# >>> blobsy-managed (do not edit) >>>');
    expect(content).toContain('model.bin');
    expect(content).toContain('# <<< blobsy-managed <<<');
  });

  it('adds entry to existing .gitignore preserving non-blobsy content', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.gitignore'), '*.log\n');

    await addGitignoreEntry(dir, 'data.bin');

    const content = await readFile(join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('*.log');
    expect(content).toContain('data.bin');
  });

  it('prevents duplicate entries', async () => {
    const dir = tmpDir();
    await addGitignoreEntry(dir, 'file.bin');
    await addGitignoreEntry(dir, 'file.bin');

    const entries = await readBlobsyBlock(join(dir, '.gitignore'));
    expect(entries.filter((e) => e === 'file.bin')).toHaveLength(1);
  });

  it('sorts entries', async () => {
    const dir = tmpDir();
    await addGitignoreEntry(dir, 'z.bin');
    await addGitignoreEntry(dir, 'a.bin');

    const entries = await readBlobsyBlock(join(dir, '.gitignore'));
    expect(entries).toEqual(['a.bin', 'z.bin']);
  });

  it('removes entry', async () => {
    const dir = tmpDir();
    await addGitignoreEntry(dir, 'model.bin');
    await addGitignoreEntry(dir, 'data.bin');
    await removeGitignoreEntry(dir, 'model.bin');

    const entries = await readBlobsyBlock(join(dir, '.gitignore'));
    expect(entries).toEqual(['data.bin']);
  });

  it('reads empty block from non-existent file', async () => {
    const dir = tmpDir();
    const entries = await readBlobsyBlock(join(dir, '.gitignore'));
    expect(entries).toEqual([]);
  });
});

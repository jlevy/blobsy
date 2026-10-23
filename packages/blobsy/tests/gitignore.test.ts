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

describe('damaged managed-block markers (LIB-02)', () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'blobsy-gitignore-lib02-'));
  }

  const START = '# >>> blobsy-managed (do not edit) >>>';
  const END = '# <<< blobsy-managed <<<';

  it('does not absorb user lines after an unterminated START on read', async () => {
    const dir = tmpDir();
    const path = join(dir, '.gitignore');
    writeFileSync(path, `*.log\n${START}\nmodel.bin\nuser-pattern/\n`);

    // No END: nothing can be safely attributed to the block.
    expect(await readBlobsyBlock(path)).toEqual([]);
  });

  it('preserves user content after an unterminated START on write', async () => {
    const dir = tmpDir();
    const path = join(dir, '.gitignore');
    writeFileSync(path, `*.log\n${START}\nold-entry.bin\nuser-pattern/\n`);

    await addGitignoreEntry(dir, 'new.bin');

    const content = await readFile(path, 'utf-8');
    // Old behavior deleted everything after the stray START.
    expect(content).toContain('user-pattern/');
    expect(content).toContain('old-entry.bin');
    expect(content).toContain('new.bin');
    // The appended block is well-formed, so reads work again.
    expect(await readBlobsyBlock(path)).toEqual(['new.bin']);
  });

  it('does not garble the file when END appears before START', async () => {
    const dir = tmpDir();
    const path = join(dir, '.gitignore');
    writeFileSync(path, `${END}\n*.log\n${START}\nentry.bin\n${END}\nuser-after\n`);

    // Stray leading END is user content; the well-formed pair still parses.
    expect(await readBlobsyBlock(path)).toEqual(['entry.bin']);

    await addGitignoreEntry(dir, 'added.bin');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('*.log');
    expect(content).toContain('user-after');
    expect(await readBlobsyBlock(path)).toEqual(['added.bin', 'entry.bin']);
  });

  it('recovers when only a stray END exists', async () => {
    const dir = tmpDir();
    const path = join(dir, '.gitignore');
    writeFileSync(path, `${END}\n*.log\n`);

    expect(await readBlobsyBlock(path)).toEqual([]);

    await addGitignoreEntry(dir, 'file.bin');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('*.log');
    expect(await readBlobsyBlock(path)).toEqual(['file.bin']);
  });
});

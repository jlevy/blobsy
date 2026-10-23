import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { findTrackableFiles } from '../src/paths.js';

describe('findTrackableFiles', () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'blobsy-paths-test-'));
  }

  it('finds all files without ignore patterns', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'hello');
    writeFileSync(join(dir, 'sub', 'nested.txt'), 'world');

    const files = findTrackableFiles(dir);
    expect(files.map((f) => f.replace(dir + '/', ''))).toEqual(['file.txt', 'sub/nested.txt']);
  });

  it('skips dotfiles and .bref files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'file.txt'), 'hello');
    writeFileSync(join(dir, '.hidden'), 'hidden');
    writeFileSync(join(dir, 'data.bin.bref'), 'ref');

    const files = findTrackableFiles(dir);
    expect(files.map((f) => f.replace(dir + '/', ''))).toEqual(['file.txt']);
  });

  it('skips files matching ignore patterns', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'file.txt'), 'hello');
    writeFileSync(join(dir, 'temp.tmp'), 'tmp');

    const files = findTrackableFiles(dir, ['*.tmp']);
    expect(files.map((f) => f.replace(dir + '/', ''))).toEqual(['file.txt']);
  });

  it('skips directories matching ignore patterns (node_modules/**)', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'file.txt'), 'hello');
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module');
    writeFileSync(join(dir, 'node_modules', 'package.json'), 'pkg');

    const files = findTrackableFiles(dir, ['node_modules/**']);
    expect(files.map((f) => f.replace(dir + '/', ''))).toEqual(['file.txt']);
  });

  it('does not recurse into ignored directories', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'file.txt'), 'hello');
    // Create deeply nested structure inside node_modules
    mkdirSync(join(dir, 'node_modules', 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'a', 'b', 'c', 'deep.js'), 'deep');

    const files = findTrackableFiles(dir, ['node_modules/**']);
    // Only file.txt should be found — node_modules skipped entirely
    expect(files.map((f) => f.replace(dir + '/', ''))).toEqual(['file.txt']);
  });

  it('applies multiple ignore patterns', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'file.txt'), 'hello');
    writeFileSync(join(dir, 'temp.tmp'), 'tmp');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'bundled');
    writeFileSync(join(dir, 'cache.pyc'), 'bytecode');

    const files = findTrackableFiles(dir, ['*.tmp', 'dist/**', '*.pyc']);
    expect(files.map((f) => f.replace(dir + '/', ''))).toEqual(['file.txt']);
  });

  it('with no patterns behaves as before (only skips dotfiles)', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'hello');
    writeFileSync(join(dir, 'node_modules', 'pkg.json'), 'pkg');

    // Without ignore patterns, node_modules is NOT skipped
    const files = findTrackableFiles(dir);
    const relPaths = files.map((f) => f.replace(dir + '/', ''));
    expect(relPaths).toContain('node_modules/pkg.json');
    expect(relPaths).toContain('file.txt');
  });
});

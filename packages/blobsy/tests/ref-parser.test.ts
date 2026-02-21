import { writeFileSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { readYRef, validateFormatVersion, writeYRef } from '../src/ref.js';
import type { YRef } from '../src/types.js';
import { YREF_FORMAT } from '../src/types.js';

describe('ref parser', () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'blobsy-ref-test-'));
  }

  it('parses a valid .yref file', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'test.yref');
    writeFileSync(refPath, `# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-yref/0.1
hash: sha256:${'a'.repeat(64)}
size: 1024
`);

    const ref = await readYRef(refPath);
    expect(ref.format).toBe('blobsy-yref/0.1');
    expect(ref.hash).toBe('sha256:' + 'a'.repeat(64));
    expect(ref.size).toBe(1024);
    expect(ref.remote_key).toBeUndefined();
  });

  it('parses a .yref file with optional fields', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'test.yref');
    writeFileSync(refPath, `format: blobsy-yref/0.1
hash: sha256:${'b'.repeat(64)}
size: 2048
remote_key: sha256/test
compressed: zstd
compressed_size: 512
`);

    const ref = await readYRef(refPath);
    expect(ref.remote_key).toBe('sha256/test');
    expect(ref.compressed).toBe('zstd');
    expect(ref.compressed_size).toBe(512);
  });

  it('serializes with correct field order and comment header', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'output.yref');

    const ref: YRef = {
      format: YREF_FORMAT,
      hash: 'sha256:' + 'c'.repeat(64),
      size: 4096,
      remote_key: 'test/key',
    };

    await writeYRef(refPath, ref);

    const content = await readFile(refPath, 'utf-8');
    expect(content).toContain('# blobsy -- https://github.com/jlevy/blobsy');
    expect(content.indexOf('format:')).toBeLessThan(content.indexOf('hash:'));
    expect(content.indexOf('hash:')).toBeLessThan(content.indexOf('size:'));
    expect(content.indexOf('size:')).toBeLessThan(content.indexOf('remote_key:'));
    expect(content).not.toContain('compressed');
  });

  it('round-trips correctly', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'roundtrip.yref');

    const original: YRef = {
      format: YREF_FORMAT,
      hash: 'sha256:' + 'd'.repeat(64),
      size: 8192,
    };

    await writeYRef(refPath, original);
    const parsed = await readYRef(refPath);

    expect(parsed.format).toBe(original.format);
    expect(parsed.hash).toBe(original.hash);
    expect(parsed.size).toBe(original.size);
    expect(parsed.remote_key).toBeUndefined();
  });

  it('rejects malformed YAML', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'bad.yref');
    writeFileSync(refPath, ':::not yaml:::');

    await expect(readYRef(refPath)).rejects.toThrow('Missing or invalid');
  });

  it('rejects missing format field', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'noformat.yref');
    writeFileSync(refPath, 'hash: sha256:abc\nsize: 100\n');

    await expect(readYRef(refPath)).rejects.toThrow('format');
  });

  it('rejects unsupported major version', () => {
    expect(() => { validateFormatVersion('blobsy-yref/2.0'); }).toThrow('Unsupported');
  });

  it('accepts current format version', () => {
    expect(() => { validateFormatVersion(YREF_FORMAT); }).not.toThrow();
  });
});

import { writeFileSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { readBref, validateFormatVersion, writeBref } from '../src/ref.js';
import type { Bref } from '../src/types.js';
import { BREF_FORMAT } from '../src/types.js';

describe('ref parser', () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'blobsy-ref-test-'));
  }

  it('parses a valid .bref file', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'test.bref');
    writeFileSync(
      refPath,
      `# blobsy -- https://github.com/jlevy/blobsy

format: blobsy-bref/0.1
hash: sha256:${'a'.repeat(64)}
size: 1024
`,
    );

    const ref = await readBref(refPath);
    expect(ref.format).toBe('blobsy-bref/0.1');
    expect(ref.hash).toBe('sha256:' + 'a'.repeat(64));
    expect(ref.size).toBe(1024);
    expect(ref.remote_key).toBeUndefined();
  });

  it('parses a .bref file with optional fields', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'test.bref');
    writeFileSync(
      refPath,
      `format: blobsy-bref/0.1
hash: sha256:${'b'.repeat(64)}
size: 2048
remote_key: sha256/test
compressed: zstd
compressed_size: 512
`,
    );

    const ref = await readBref(refPath);
    expect(ref.remote_key).toBe('sha256/test');
    expect(ref.compressed).toBe('zstd');
    expect(ref.compressed_size).toBe(512);
  });

  it('serializes with correct field order and comment header', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'output.bref');

    const ref: Bref = {
      format: BREF_FORMAT,
      hash: 'sha256:' + 'c'.repeat(64),
      size: 4096,
      remote_key: 'test/key',
    };

    await writeBref(refPath, ref);

    const content = await readFile(refPath, 'utf-8');
    expect(content).toContain('# blobsy -- https://github.com/jlevy/blobsy');
    expect(content).toContain('# Run: blobsy status | blobsy --help');
    expect(content.indexOf('format:')).toBeLessThan(content.indexOf('hash:'));
    expect(content.indexOf('hash:')).toBeLessThan(content.indexOf('size:'));
    expect(content.indexOf('size:')).toBeLessThan(content.indexOf('remote_key:'));
    expect(content).not.toContain('compressed');
  });

  it('round-trips correctly', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'roundtrip.bref');

    const original: Bref = {
      format: BREF_FORMAT,
      hash: 'sha256:' + 'd'.repeat(64),
      size: 8192,
    };

    await writeBref(refPath, original);
    const parsed = await readBref(refPath);

    expect(parsed.format).toBe(original.format);
    expect(parsed.hash).toBe(original.hash);
    expect(parsed.size).toBe(original.size);
    expect(parsed.remote_key).toBeUndefined();
  });

  it('rejects malformed YAML', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'bad.bref');
    writeFileSync(refPath, ':::not yaml:::');

    await expect(readBref(refPath)).rejects.toThrow('Missing or invalid');
  });

  it('rejects missing format field', async () => {
    const dir = tmpDir();
    const refPath = join(dir, 'noformat.bref');
    writeFileSync(refPath, 'hash: sha256:abc\nsize: 100\n');

    await expect(readBref(refPath)).rejects.toThrow('format');
  });

  it('rejects unsupported major version', () => {
    expect(() => {
      validateFormatVersion('blobsy-bref/2.0');
    }).toThrow('Unsupported');
  });

  it('accepts current format version', () => {
    expect(() => {
      validateFormatVersion(BREF_FORMAT);
    }).not.toThrow();
  });
});

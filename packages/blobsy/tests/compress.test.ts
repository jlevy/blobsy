import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { shouldCompress, compressFile, decompressFile } from '../src/compress.js';
import type { CompressConfig } from '../src/types.js';

const defaultConfig: CompressConfig = {
  algorithm: 'gzip',
  min_size: '0',
  always: [],
  never: [],
};

describe('shouldCompress', () => {
  it('returns false when algorithm is none', () => {
    expect(shouldCompress('file.bin', 1000, { ...defaultConfig, algorithm: 'none' })).toBe(false);
  });

  it('returns true for files above min_size', () => {
    expect(shouldCompress('file.bin', 2000, { ...defaultConfig, min_size: '1KB' })).toBe(true);
  });

  it('returns false for files below min_size', () => {
    expect(shouldCompress('file.bin', 500, { ...defaultConfig, min_size: '1KB' })).toBe(false);
  });

  it('respects never patterns', () => {
    expect(shouldCompress('file.gz', 2000, { ...defaultConfig, never: ['*.gz'] })).toBe(false);
  });

  it('respects always patterns', () => {
    expect(
      shouldCompress('file.txt', 0, { ...defaultConfig, min_size: '1GB', always: ['*.txt'] }),
    ).toBe(true);
  });

  it('never takes precedence over always', () => {
    expect(
      shouldCompress('file.txt', 0, {
        ...defaultConfig,
        always: ['*.txt'],
        never: ['*.txt'],
      }),
    ).toBe(false);
  });
});

describe('compressFile/decompressFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'blobsy-compress-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips gzip compression', async () => {
    const srcPath = join(tmpDir, 'input.txt');
    const compressedPath = join(tmpDir, 'input.txt.gz');
    const decompressedPath = join(tmpDir, 'output.txt');
    const content = 'Hello, world! '.repeat(100);
    await writeFile(srcPath, content);

    const compressedSize = await compressFile(srcPath, compressedPath, 'gzip');
    expect(compressedSize).toBeGreaterThan(0);
    expect(compressedSize).toBeLessThan(content.length);

    await decompressFile(compressedPath, decompressedPath, 'gzip');
    const result = await readFile(decompressedPath, 'utf-8');
    expect(result).toBe(content);
  });

  it('round-trips brotli compression', async () => {
    const srcPath = join(tmpDir, 'input.txt');
    const compressedPath = join(tmpDir, 'input.txt.br');
    const decompressedPath = join(tmpDir, 'output.txt');
    const content = 'Brotli test data. '.repeat(100);
    await writeFile(srcPath, content);

    const compressedSize = await compressFile(srcPath, compressedPath, 'brotli');
    expect(compressedSize).toBeGreaterThan(0);
    expect(compressedSize).toBeLessThan(content.length);

    await decompressFile(compressedPath, decompressedPath, 'brotli');
    const result = await readFile(decompressedPath, 'utf-8');
    expect(result).toBe(content);
  });

  it('throws for unsupported algorithm', async () => {
    const srcPath = join(tmpDir, 'input.txt');
    await writeFile(srcPath, 'test');
    await expect(compressFile(srcPath, join(tmpDir, 'out'), 'lz4')).rejects.toThrow(
      'Unsupported compression',
    );
  });

  it('round-trips zstd compression', async () => {
    const srcPath = join(tmpDir, 'input.txt');
    const compressedPath = join(tmpDir, 'input.txt.zst');
    const decompressedPath = join(tmpDir, 'output.txt');
    const content = 'Zstd test data. '.repeat(100);
    await writeFile(srcPath, content);

    const compressedSize = await compressFile(srcPath, compressedPath, 'zstd');
    expect(compressedSize).toBeGreaterThan(0);
    expect(compressedSize).toBeLessThan(content.length);

    await decompressFile(compressedPath, decompressedPath, 'zstd');
    const result = await readFile(decompressedPath, 'utf-8');
    expect(result).toBe(content);
  });
});

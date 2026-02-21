/**
 * Compression utilities.
 *
 * Streaming compress/decompress via node:zlib for zstd, gzip, brotli.
 * Decides per-file whether to compress based on config rules.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  createBrotliCompress,
  createBrotliDecompress,
  createGzip,
  createGunzip,
  createZstdCompress,
  createZstdDecompress,
} from 'node:zlib';

import picomatch from 'picomatch';

import type { CompressConfig } from './types.js';
import { BlobsyError } from './types.js';
import { parseSize } from './config.js';

/**
 * Decide whether a file should be compressed based on config rules.
 *
 * Decision order: (1) never patterns, (2) always patterns, (3) min_size.
 */
export function shouldCompress(
  filePath: string,
  fileSize: number,
  config: CompressConfig,
): boolean {
  if (config.algorithm === 'none') {
    return false;
  }

  const filename = filePath.split('/').pop() ?? filePath;

  if (config.never.length > 0) {
    const neverMatcher = picomatch(config.never);
    if (neverMatcher(filename) || neverMatcher(filePath)) {
      return false;
    }
  }

  if (config.always.length > 0) {
    const alwaysMatcher = picomatch(config.always);
    if (alwaysMatcher(filename) || alwaysMatcher(filePath)) {
      return true;
    }
  }

  const minSize = parseSize(config.min_size);
  return fileSize >= minSize;
}

/** Compress a file to a destination path. Returns compressed size. */
export async function compressFile(
  srcPath: string,
  destPath: string,
  algorithm: string,
): Promise<number> {
  const compressor = createCompressor(algorithm);
  const src = createReadStream(srcPath);
  const dest = createWriteStream(destPath);

  await pipeline(src, compressor, dest);

  const stats = await stat(destPath);
  return Number(stats.size);
}

/** Decompress a file to a destination path. */
export async function decompressFile(
  srcPath: string,
  destPath: string,
  algorithm: string,
): Promise<void> {
  const decompressor = createDecompressor(algorithm);
  const src = createReadStream(srcPath);
  const dest = createWriteStream(destPath);

  await pipeline(src, decompressor, dest);
}

function createCompressor(algorithm: string): NodeJS.ReadWriteStream {
  switch (algorithm) {
    case 'gzip':
      return createGzip();
    case 'brotli':
      return createBrotliCompress();
    case 'zstd':
      return createZstdCompress();
    default:
      throw new BlobsyError(`Unsupported compression algorithm: ${algorithm}`, 'validation');
  }
}

function createDecompressor(algorithm: string): NodeJS.ReadWriteStream {
  switch (algorithm) {
    case 'gzip':
      return createGunzip();
    case 'brotli':
      return createBrotliDecompress();
    case 'zstd':
      return createZstdDecompress();
    default:
      throw new BlobsyError(`Unsupported decompression algorithm: ${algorithm}`, 'validation');
  }
}

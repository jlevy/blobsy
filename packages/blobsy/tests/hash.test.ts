import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { computeHash, formatHash, hashString, isValidHash, parseHash } from '../src/hash.js';

describe('hash', () => {
  it('computes known SHA-256 hash for content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blobsy-test-'));
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'hello blobsy\n');

    const hash = await computeHash(filePath);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('returns consistent hash for same content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blobsy-test-'));
    const file1 = join(dir, 'a.txt');
    const file2 = join(dir, 'b.txt');
    writeFileSync(file1, 'identical content');
    writeFileSync(file2, 'identical content');

    expect(await computeHash(file1)).toBe(await computeHash(file2));
  });

  it('handles empty file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blobsy-test-'));
    const filePath = join(dir, 'empty.txt');
    writeFileSync(filePath, '');

    const hash = await computeHash(filePath);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // SHA-256 of empty string is well-known
    expect(hash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('formatHash produces correct format', () => {
    expect(formatHash('abc123')).toBe('sha256:abc123');
  });

  it('parseHash extracts hex digest', () => {
    expect(parseHash('sha256:abc123')).toBe('abc123');
  });

  it('parseHash rejects invalid format', () => {
    expect(() => parseHash('md5:abc')).toThrow('Invalid hash format');
  });

  it('hashString hashes a string', () => {
    const result = hashString('test');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isValidHash validates correctly', () => {
    expect(isValidHash('sha256:' + 'a'.repeat(64))).toBe(true);
    expect(isValidHash('sha256:' + 'a'.repeat(63))).toBe(false);
    expect(isValidHash('md5:' + 'a'.repeat(64))).toBe(false);
    expect(isValidHash('invalid')).toBe(false);
  });
});

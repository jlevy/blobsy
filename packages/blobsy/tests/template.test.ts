import { describe, expect, it } from 'vitest';

import {
  evaluateTemplate,
  formatIsoDateSecs,
  getCompressSuffix,
  sanitizeKeyComponent,
} from '../src/template.js';

describe('getCompressSuffix', () => {
  it('returns .gz for gzip', () => {
    expect(getCompressSuffix('gzip')).toBe('.gz');
  });

  it('returns .br for brotli', () => {
    expect(getCompressSuffix('brotli')).toBe('.br');
  });

  it('returns .zst for zstd', () => {
    expect(getCompressSuffix('zstd')).toBe('.zst');
  });

  it('returns empty string for undefined', () => {
    expect(getCompressSuffix(undefined)).toBe('');
  });

  it('returns empty string for none', () => {
    expect(getCompressSuffix('none')).toBe('');
  });
});

describe('formatIsoDateSecs', () => {
  it('formats a date correctly', () => {
    const date = new Date('2026-02-21T15:30:45Z');
    expect(formatIsoDateSecs(date)).toBe('20260221T153045Z');
  });

  it('zero-pads single digit months and days', () => {
    const date = new Date('2026-01-05T03:07:09Z');
    expect(formatIsoDateSecs(date)).toBe('20260105T030709Z');
  });
});

describe('sanitizeKeyComponent', () => {
  it('passes through clean paths unchanged', () => {
    expect(sanitizeKeyComponent('data/model.bin')).toBe('data/model.bin');
  });

  it('replaces backslashes with underscores', () => {
    expect(sanitizeKeyComponent('data\\model.bin')).toBe('data_model.bin');
  });

  it('replaces whitespace with hyphens', () => {
    expect(sanitizeKeyComponent('my file name.bin')).toBe('my-file-name.bin');
  });

  it('collapses consecutive special chars', () => {
    expect(sanitizeKeyComponent('a__b--c')).toBe('a_b_c');
  });

  it('replaces control characters', () => {
    expect(sanitizeKeyComponent('file\x00name\x1f.bin')).toBe('file_name_.bin');
  });

  it('removes S3-problematic characters', () => {
    expect(sanitizeKeyComponent('path/{branch}/[tag]#1')).toBe('path/_branch_/_tag_1');
  });

  it('strips leading dots from path segments', () => {
    expect(sanitizeKeyComponent('.hidden/file')).toBe('hidden/file');
    expect(sanitizeKeyComponent('dir/..sneaky')).toBe('dir/sneaky');
  });

  it('preserves forward slashes', () => {
    expect(sanitizeKeyComponent('a/b/c/d.bin')).toBe('a/b/c/d.bin');
  });

  it('handles branch names with special chars', () => {
    expect(sanitizeKeyComponent('feature/my-branch')).toBe('feature/my-branch');
    expect(sanitizeKeyComponent('user/name@host')).toBe('user/name@host');
  });
});

describe('evaluateTemplate', () => {
  const hash = 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const timestamp = new Date('2026-02-21T15:30:45Z');

  it('evaluates default template', () => {
    const template = '{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}';
    const result = evaluateTemplate(template, {
      hash,
      repoPath: 'data/model.bin',
      compressSuffix: '',
      timestamp,
    });
    expect(result).toBe('20260221T153045Z-abcdef123456/data/model.bin');
  });

  it('includes compress suffix', () => {
    const template = '{repo_path}{compress_suffix}';
    const result = evaluateTemplate(template, {
      hash,
      repoPath: 'data/model.bin',
      compressSuffix: '.gz',
      timestamp,
    });
    expect(result).toBe('data/model.bin.gz');
  });

  it('expands dirname with trailing slash', () => {
    const template = '{dirname}{filename}';
    const result = evaluateTemplate(template, {
      hash,
      repoPath: 'data/model.bin',
      compressSuffix: '',
      timestamp,
    });
    expect(result).toBe('data/model.bin');
  });

  it('handles root-level file dirname', () => {
    const template = '{dirname}{filename}';
    const result = evaluateTemplate(template, {
      hash,
      repoPath: 'model.bin',
      compressSuffix: '',
      timestamp,
    });
    expect(result).toBe('model.bin');
  });

  it('expands full sha256', () => {
    const template = '{content_sha256}';
    const result = evaluateTemplate(template, {
      hash,
      repoPath: 'file.txt',
      compressSuffix: '',
    });
    expect(result).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  it('leaves unknown variables as-is', () => {
    const template = '{unknown_var}';
    const result = evaluateTemplate(template, {
      hash,
      repoPath: 'file.txt',
      compressSuffix: '',
    });
    expect(result).toBe('{unknown_var}');
  });
});

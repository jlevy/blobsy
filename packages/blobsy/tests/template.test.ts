import { describe, expect, it } from 'vitest';

import { evaluateTemplate, formatIsoDateSecs, getCompressSuffix } from '../src/template.js';

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

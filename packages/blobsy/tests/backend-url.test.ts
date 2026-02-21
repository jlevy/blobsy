import { describe, expect, it } from 'vitest';

import { parseBackendUrl, validateBackendUrl } from '../src/backend-url.js';

describe('parseBackendUrl', () => {
  it('parses S3 URL', () => {
    const result = parseBackendUrl('s3://my-bucket/my-prefix/');
    expect(result.type).toBe('s3');
    expect(result.bucket).toBe('my-bucket');
    expect(result.prefix).toBe('my-prefix/');
  });

  it('parses GCS URL', () => {
    const result = parseBackendUrl('gs://my-bucket/prefix/');
    expect(result.type).toBe('gcs');
    expect(result.bucket).toBe('my-bucket');
  });

  it('parses Azure URL', () => {
    const result = parseBackendUrl('azure://my-container/prefix/');
    expect(result.type).toBe('azure');
    expect(result.bucket).toBe('my-container');
  });

  it('parses local URL', () => {
    const result = parseBackendUrl('local:../blobsy-remote');
    expect(result.type).toBe('local');
    expect(result.path).toBe('../blobsy-remote');
  });

  it('normalizes trailing slash on prefix', () => {
    const result = parseBackendUrl('s3://bucket/prefix');
    expect(result.prefix).toBe('prefix/');
  });

  it('rejects empty URL', () => {
    expect(() => parseBackendUrl('')).toThrow('required');
  });

  it('rejects bare paths', () => {
    expect(() => parseBackendUrl('../remote')).toThrow("Did you mean 'local:");
  });

  it('rejects unrecognized scheme', () => {
    expect(() => parseBackendUrl('ftp://host/path')).toThrow('Unrecognized');
  });

  it('rejects query strings', () => {
    expect(() => parseBackendUrl('s3://bucket/prefix?key=val')).toThrow('query strings');
  });

  it('rejects S3 URL without prefix', () => {
    expect(() => parseBackendUrl('s3://my-bucket')).toThrow('requires a prefix');
  });

  it('rejects invalid bucket name', () => {
    expect(() => parseBackendUrl('s3://AB/prefix/')).toThrow('Bucket name');
  });

  it('rejects prefix starting with slash', () => {
    expect(() => parseBackendUrl('s3://bucket//prefix/')).toThrow('Prefix must not');
  });

  it('case-insensitive scheme matching', () => {
    const result = parseBackendUrl('S3://my-bucket/prefix/');
    expect(result.type).toBe('s3');
  });
});

describe('validateBackendUrl', () => {
  it('rejects local path inside repo', () => {
    const parsed = parseBackendUrl('local:./subdir');
    expect(() => { validateBackendUrl(parsed, '/tmp/repo'); }).toThrow('outside the git repository');
  });
});

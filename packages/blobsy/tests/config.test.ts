import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  getBuiltinDefaults,
  loadConfigFile,
  mergeConfigs,
  parseSize,
} from '../src/config.js';

describe('config', () => {
  function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'blobsy-config-test-'));
  }

  it('returns built-in defaults', () => {
    const defaults = getBuiltinDefaults();
    expect(defaults.externalize?.min_size).toBe('1mb');
    expect(defaults.compress?.algorithm).toBe('zstd');
    expect(defaults.sync?.parallel).toBe(8);
    expect(defaults.checksum?.algorithm).toBe('sha256');
  });

  it('loads a valid config file', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(configPath, `backends:
  default:
    url: local:../remote
`);

    const config = await loadConfigFile(configPath);
    expect(config.backends?.default?.url).toBe('local:../remote');
  });

  it('handles empty config file', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(configPath, '');

    const config = await loadConfigFile(configPath);
    expect(config).toEqual({});
  });

  it('rejects non-object YAML', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(configPath, '"just a string"');

    await expect(loadConfigFile(configPath)).rejects.toThrow('not an object');
  });

  it('merges configs with shallow override', () => {
    const base = getBuiltinDefaults();
    const override = {
      externalize: {
        min_size: '5mb' as const,
        always: ['*.parquet'],
        never: [],
      },
    };

    const merged = mergeConfigs(base, override);
    expect(merged.externalize?.min_size).toBe('5mb');
    expect(merged.externalize?.always).toEqual(['*.parquet']);
    // Shallow merge: compress should remain from base
    expect(merged.compress?.algorithm).toBe('zstd');
  });
});

describe('parseSize', () => {
  it('parses bytes', () => {
    expect(parseSize('100b')).toBe(100);
  });

  it('parses kilobytes', () => {
    expect(parseSize('100kb')).toBe(100 * 1024);
  });

  it('parses megabytes', () => {
    expect(parseSize('1mb')).toBe(1024 * 1024);
  });

  it('parses gigabytes', () => {
    expect(parseSize('2gb')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('accepts numeric input', () => {
    expect(parseSize(1024)).toBe(1024);
  });

  it('rejects invalid format', () => {
    expect(() => parseSize('invalid')).toThrow('Invalid size format');
  });
});

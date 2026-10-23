import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  getBuiltinDefaults,
  getGlobalConfigPath,
  loadConfigFile,
  mergeConfigs,
  parseSize,
  resolveConfig,
  resolveConfigWithOrigins,
  unsetNestedValue,
} from '../src/config.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'blobsy-config-test-'));
}

let originalBlobsyHome: string | undefined;

// Set BLOBSY_HOME to a temp directory for all tests
beforeEach(() => {
  originalBlobsyHome = process.env.BLOBSY_HOME;
  process.env.BLOBSY_HOME = tmpDir();
});

afterEach(() => {
  if (originalBlobsyHome === undefined) {
    delete process.env.BLOBSY_HOME;
  } else {
    process.env.BLOBSY_HOME = originalBlobsyHome;
  }
});

describe('config', () => {
  it('returns built-in defaults', () => {
    const defaults = getBuiltinDefaults();
    expect(defaults.externalize?.min_size).toBe('200kb');
    expect(defaults.compress?.algorithm).toBe('zstd');
    expect(defaults.sync?.tools).toEqual(['aws-cli', 'rclone']);
    expect(defaults.checksum?.algorithm).toBe('sha256');
  });

  it('loads a valid config file', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(
      configPath,
      `backends:
  default:
    url: local:../remote
`,
    );

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

  it('merges section objects one level deep (CFG-02)', () => {
    const base = getBuiltinDefaults();
    // A subdir override setting ONLY externalize.always must keep the
    // parent's min_size and never.
    const merged = mergeConfigs(base, {
      externalize: { always: ['*.parquet'] } as never,
    });
    expect(merged.externalize?.always).toEqual(['*.parquet']);
    expect(merged.externalize?.min_size).toBe('200kb');
    expect(merged.externalize?.never).toEqual([]);
  });

  it('merges backends by name, keeping parent backends (CFG-02)', () => {
    const base = { backends: { default: { url: 'local:../remote' } } };
    const merged = mergeConfigs(base, {
      backends: { archive: { url: 's3://bucket/archive' } },
    });
    expect(merged.backends?.default?.url).toBe('local:../remote');
    expect(merged.backends?.archive?.url).toBe('s3://bucket/archive');
  });

  it('replaces arrays and scalars wholesale', () => {
    const base = getBuiltinDefaults();
    const merged = mergeConfigs(base, { ignore: ['only-this/**'] });
    expect(merged.ignore).toEqual(['only-this/**']);
  });

  it('rejects wrong-typed config values at load time (CFG-03)', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(configPath, 'externalize:\n  min_size: true\n');

    await expect(loadConfigFile(configPath)).rejects.toThrow(/externalize\.min_size/);
  });

  it('accepts a single-string pattern list (blobsy config writes scalars)', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(configPath, 'externalize:\n  never: "*.md"\nignore: "*.tmp"\n');

    const config = await loadConfigFile(configPath);
    expect(config.externalize?.never).toBe('*.md');
  });

  it('rejects wrong-typed ignore at load time (CFG-03)', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(configPath, 'ignore: 5\n');

    await expect(loadConfigFile(configPath)).rejects.toThrow(/ignore/);
  });

  it('reports unresolved merge conflict markers clearly (CFG-03)', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(
      configPath,
      '<<<<<<< HEAD\nbackends:\n  default:\n    url: local:a\n=======\nbackends:\n  default:\n    url: local:b\n>>>>>>> theirs\n',
    );

    await expect(loadConfigFile(configPath)).rejects.toThrow(/merge conflict markers/);
  });

  it('warns about and strips an in-repo trust_command_backends grant (SEC-03)', async () => {
    const repoDir = tmpDir();
    writeFileSync(
      join(repoDir, '.blobsy.yml'),
      'backends:\n  default:\n    url: local:remote\ntrust_command_backends: true\n',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = await resolveConfig(repoDir, repoDir);
      expect('trust_command_backends' in config).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ignoring trust_command_backends'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts unknown top-level keys (doctor reports them instead)', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(configPath, 'some_future_key: 1\n');

    const config = await loadConfigFile(configPath);
    expect((config as Record<string, unknown>).some_future_key).toBe(1);
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

describe('getGlobalConfigPath', () => {
  it('respects BLOBSY_HOME when set', () => {
    const path = getGlobalConfigPath();
    // BLOBSY_HOME is set in beforeEach to a temp directory
    expect(path).toBe(join(process.env.BLOBSY_HOME!, '.blobsy.yml'));
  });

  it('falls back to homedir when BLOBSY_HOME is not set', () => {
    delete process.env.BLOBSY_HOME;
    const path = getGlobalConfigPath();
    expect(path).toBe(join(homedir(), '.blobsy.yml'));
  });
});

describe('unsetNestedValue', () => {
  it('removes a top-level key', () => {
    const obj = { foo: 'bar', baz: 'qux' };
    const removed = unsetNestedValue(obj, 'foo');
    expect(removed).toBe(true);
    expect(obj).toEqual({ baz: 'qux' });
  });

  it('removes a nested key', () => {
    const obj = { compress: { algorithm: 'zstd', min_size: '100kb' } };
    const removed = unsetNestedValue(obj, 'compress.algorithm');
    expect(removed).toBe(true);
    expect(obj).toEqual({ compress: { min_size: '100kb' } });
  });

  it('returns false for non-existent key', () => {
    const obj = { foo: 'bar' };
    const removed = unsetNestedValue(obj, 'nonexistent');
    expect(removed).toBe(false);
    expect(obj).toEqual({ foo: 'bar' });
  });

  it('returns false for non-existent nested key', () => {
    const obj = { foo: { bar: 'baz' } };
    const removed = unsetNestedValue(obj, 'foo.nonexistent');
    expect(removed).toBe(false);
    expect(obj).toEqual({ foo: { bar: 'baz' } });
  });

  it('returns false when parent is not an object', () => {
    const obj = { foo: 'bar' };
    const removed = unsetNestedValue(obj, 'foo.nested');
    expect(removed).toBe(false);
    expect(obj).toEqual({ foo: 'bar' });
  });
});

describe('resolveConfigWithOrigins', () => {
  it('tracks builtin defaults', async () => {
    const dir = tmpDir();
    const origins = await resolveConfigWithOrigins(dir, dir);

    // Check a few builtin values
    expect(origins.get('compress.algorithm')).toMatchObject({
      value: 'zstd',
      origin: 'builtin',
      file: undefined,
    });
    expect(origins.get('externalize.min_size')).toMatchObject({
      value: '200kb',
      origin: 'builtin',
      file: undefined,
    });
  });

  it('tracks repo config overrides', async () => {
    const dir = tmpDir();
    const configPath = join(dir, '.blobsy.yml');
    writeFileSync(
      configPath,
      `compress:
  algorithm: gzip
`,
    );

    const origins = await resolveConfigWithOrigins(dir, dir);

    expect(origins.get('compress.algorithm')).toMatchObject({
      value: 'gzip',
      origin: 'repo',
      file: configPath,
    });
    // Other values should still be builtin
    expect(origins.get('externalize.min_size')).toMatchObject({
      value: '200kb',
      origin: 'builtin',
      file: undefined,
    });
  });

  it('tracks subdir config overrides', async () => {
    const dir = tmpDir();
    const repoConfigPath = join(dir, '.blobsy.yml');
    writeFileSync(
      repoConfigPath,
      `compress:
  algorithm: gzip
`,
    );

    const subdirPath = join(dir, 'subdir');
    mkdirSync(subdirPath);
    const subdirConfigPath = join(subdirPath, '.blobsy.yml');
    writeFileSync(
      subdirConfigPath,
      `compress:
  algorithm: lz4
`,
    );

    const origins = await resolveConfigWithOrigins(subdirPath, dir);

    expect(origins.get('compress.algorithm')).toMatchObject({
      value: 'lz4',
      origin: 'subdir',
      file: subdirConfigPath,
    });
  });
});

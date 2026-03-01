import { describe, expect, it } from 'vitest';

import { shouldExternalize, filterFilesForExternalization } from '../src/externalize.js';
import type { ExternalizeConfig } from '../src/types.js';

const defaultConfig: ExternalizeConfig = {
  min_size: '200kb',
  always: ['*.parquet', '*.bin'],
  never: ['*.md'],
};

describe('shouldExternalize', () => {
  it('always externalizes matching always patterns', () => {
    expect(shouldExternalize('data/model.bin', 100, defaultConfig)).toBe(true);
    expect(shouldExternalize('data/file.parquet', 100, defaultConfig)).toBe(true);
  });

  it('never externalizes matching never patterns', () => {
    expect(shouldExternalize('README.md', 10 * 1024 * 1024, defaultConfig)).toBe(false);
  });

  it('externalizes files above min_size', () => {
    expect(shouldExternalize('data/file.txt', 2 * 1024 * 1024, defaultConfig)).toBe(true);
  });

  it('does not externalize files below min_size', () => {
    expect(shouldExternalize('data/file.txt', 100, defaultConfig)).toBe(false);
  });

  it('never takes priority over always', () => {
    const config: ExternalizeConfig = {
      min_size: 0,
      always: ['*.bin'],
      never: ['*.bin'],
    };
    expect(shouldExternalize('test.bin', 100, config)).toBe(false);
  });
});

describe('filterFilesForExternalization', () => {
  it('filters and marks files correctly', () => {
    const files = [
      { path: 'data/big.bin', size: 100 },
      { path: 'data/small.txt', size: 100 },
      { path: 'data/large.txt', size: 2 * 1024 * 1024 },
      { path: 'README.md', size: 5 * 1024 * 1024 },
    ];

    const result = filterFilesForExternalization(files, defaultConfig, []);
    expect(result.find((f) => f.path === 'data/big.bin')?.externalize).toBe(true);
    expect(result.find((f) => f.path === 'data/small.txt')?.externalize).toBe(false);
    expect(result.find((f) => f.path === 'data/large.txt')?.externalize).toBe(true);
    expect(result.find((f) => f.path === 'README.md')?.externalize).toBe(false);
  });

  it('respects ignore patterns', () => {
    const files = [
      { path: 'node_modules/pkg/file.bin', size: 100 },
      { path: 'data/model.bin', size: 100 },
    ];

    const result = filterFilesForExternalization(files, defaultConfig, ['node_modules/**']);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('data/model.bin');
  });
});

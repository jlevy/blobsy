import { describe, expect, it } from 'vitest';

import { shouldExternalize } from '../src/externalize.js';
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

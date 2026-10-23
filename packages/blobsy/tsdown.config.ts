import { defineConfig } from 'tsdown';

import { getGitVersion } from './scripts/git-version.mjs';

const version = getGitVersion();

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  dts: true,
  clean: true,
  define: {
    __BLOBSY_VERSION__: JSON.stringify(version),
  },
});

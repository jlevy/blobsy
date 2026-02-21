import { defineConfig } from 'tsdown';

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
});

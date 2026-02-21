import { defineConfig } from 'tryscript';

export default defineConfig({
  env: {
    NO_COLOR: '1',
    BLOBSY_NO_HOOKS: '1',
  },
  timeout: 10000,
  patterns: {
    HASH: 'sha256:[0-9a-f]{64}',
    SHORT_HASH: '[0-9a-f]{12}',
    TIMESTAMP: '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z?',
    REMOTE_KEY: '\\d{8}T\\d{6}Z-[0-9a-f]+/.+',
    TMPFILE: '/tmp/blobsy-[a-z]+-[0-9a-f]+\\.tmp',
    SIZE: '\\d+',
  },
  path: ['$TRYSCRIPT_PACKAGE_BIN', '$TRYSCRIPT_PACKAGE_ROOT/bin'],
});

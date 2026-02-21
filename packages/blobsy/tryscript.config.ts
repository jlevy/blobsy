import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'tryscript';

// Shared mock remote directory for the entire test suite run.
// Each test's push creates unique content-addressed keys, so no collision.
const testRemote = mkdtempSync(join(tmpdir(), 'blobsy-test-remote-'));

export default defineConfig({
  env: {
    NO_COLOR: '1',
    BLOBSY_NO_HOOKS: '1',
    BLOBSY_BACKEND_URL: `local:${testRemote}`,
    BLOBSY_TEST_REMOTE: testRemote,
  },
  timeout: 10000,
  patterns: {
    HASH: 'sha256:[0-9a-f]{64}',
    SHORT_HASH: '[0-9a-f]{12}',
    TIMESTAMP: '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z?',
    REMOTE_KEY: '\\d{8}T\\d{6}Z-[0-9a-f]+/.+',
    TMPFILE: '/tmp/blobsy-[a-z]+-[0-9a-f]+\\.tmp',
    SIZE: '\\d+',
    SANDBOX_PATH: '/[\\w/.+-]+/tryscript-[A-Za-z0-9]+',
    LOCAL_PATH: '/[\\w/.+-]+',
    UNIX_TS: '\\d{13}',
  },
  path: ['$TRYSCRIPT_PACKAGE_BIN', '$TRYSCRIPT_PACKAGE_ROOT/bin'],
});

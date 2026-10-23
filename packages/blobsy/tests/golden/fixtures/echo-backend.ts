#!/usr/bin/env node

/**
 * Echo backend for golden testing.
 *
 * Mirrors the interface of `aws s3 cp`: takes a source and destination,
 * copies the file, and echoes the operation to stdout.
 *
 * Usage:
 *   echo-backend.ts push <local-path> <bucket>/<remote-key>
 *   echo-backend.ts pull <bucket>/<remote-key> <local-path>
 *   echo-backend.ts exists <bucket>/<remote-key>
 *
 * The "remote" is a .mock-remote/ directory relative to cwd. The bucket
 * prefix is stripped from the key for filesystem storage.
 *
 * Exit codes mirror aws-cli: 0 = success, 1 = failure.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REMOTE_DIR = '.mock-remote';

function resolveRemotePath(bucketAndKey: string): string {
  const slashIndex = bucketAndKey.indexOf('/');
  if (slashIndex === -1) {
    console.error(`Invalid remote path (expected bucket/key): ${bucketAndKey}`);
    process.exit(1);
  }
  const key = bucketAndKey.slice(slashIndex + 1);
  return join(REMOTE_DIR, key);
}

function push(localPath: string, remotePath: string): void {
  const dest = resolveRemotePath(remotePath);
  console.log(`PUSH ${localPath} -> ${remotePath}`);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(localPath, dest);
}

function pull(remotePath: string, localPath: string): void {
  const src = resolveRemotePath(remotePath);
  console.log(`PULL ${remotePath} -> ${localPath}`);
  if (!existsSync(src)) {
    console.error(`Remote blob not found: ${remotePath}`);
    process.exit(1);
  }
  mkdirSync(dirname(localPath), { recursive: true });
  copyFileSync(src, localPath);
}

function exists(remotePath: string): void {
  const src = resolveRemotePath(remotePath);
  if (existsSync(src)) {
    console.log(`EXISTS ${remotePath}`);
  } else {
    console.error(`NOT_FOUND ${remotePath}`);
    process.exit(1);
  }
}

const [action, arg1, arg2] = process.argv.slice(2);

switch (action) {
  case 'push':
    if (!arg1 || !arg2) {
      console.error('Usage: echo-backend.ts push <local> <bucket/key>');
      process.exit(1);
    }
    push(arg1, arg2);
    break;
  case 'pull':
    if (!arg1 || !arg2) {
      console.error('Usage: echo-backend.ts pull <bucket/key> <local>');
      process.exit(1);
    }
    pull(arg1, arg2);
    break;
  case 'exists':
    if (!arg1) {
      console.error('Usage: echo-backend.ts exists <bucket/key>');
      process.exit(1);
    }
    exists(arg1);
    break;
  default:
    console.error(`Unknown action: ${action}`);
    console.error('Usage: echo-backend.ts push|pull|exists ...');
    process.exit(1);
}

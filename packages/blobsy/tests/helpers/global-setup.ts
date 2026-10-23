/**
 * Prints the binary under test so every run records exactly which build was
 * exercised (review finding DX-01: non-hermetic harnesses produce false greens).
 */

import { execFileSync } from 'node:child_process';

import { CLI_PATH } from './cli.js';

export function setup(): void {
  const version = execFileSync(process.execPath, [CLI_PATH, '--version'], {
    encoding: 'utf-8',
  }).trim();
  console.log(`Testing binary: ${CLI_PATH} (${version})`);
}

#!/usr/bin/env node
/**
 * Copy documentation files to dist/docs/ for bundled CLI.
 *
 * Source: packages/blobsy/docs/ → dist/docs/
 * Also copies README.md from repo root.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const repoRoot = join(pkgRoot, '..', '..');

const distDocs = join(pkgRoot, 'dist', 'docs');
mkdirSync(distDocs, { recursive: true });

// Copy packaged docs
const DOCS = ['blobsy-docs.md', 'blobsy-docs-brief.md'];
for (const filename of DOCS) {
  const content = readFileSync(join(pkgRoot, 'docs', filename), 'utf-8');
  writeFileSync(join(distDocs, filename), content);
}

// Copy README.md from repo root
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
writeFileSync(join(distDocs, 'README.md'), readme);

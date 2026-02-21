/**
 * Trust management for command backend execution.
 *
 * Stores trust state in ~/.blobsy/trusted-repos.json.
 * Command backends in repo .blobsy.yml require explicit trust
 * since they execute arbitrary shell commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface TrustStore {
  trusted: Record<string, { trustedAt: string }>;
}

function getTrustStorePath(): string {
  return join(homedir(), '.blobsy', 'trusted-repos.json');
}

function readTrustStore(): TrustStore {
  const storePath = getTrustStorePath();
  if (!existsSync(storePath)) {
    return { trusted: {} };
  }
  try {
    const content = readFileSync(storePath, 'utf-8');
    return JSON.parse(content) as TrustStore;
  } catch {
    return { trusted: {} };
  }
}

function writeTrustStore(store: TrustStore): void {
  const storePath = getTrustStorePath();
  const dir = join(homedir(), '.blobsy');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n');
}

function normalizeRepoPath(repoRoot: string): string {
  return resolve(repoRoot);
}

/** Trust a repo for command backend execution. */
export function trustRepo(repoRoot: string): void {
  const store = readTrustStore();
  const key = normalizeRepoPath(repoRoot);
  store.trusted[key] = { trustedAt: new Date().toISOString() };
  writeTrustStore(store);
}

/** Revoke trust for a repo. */
export function revokeRepo(repoRoot: string): boolean {
  const store = readTrustStore();
  const key = normalizeRepoPath(repoRoot);
  if (!(key in store.trusted)) {
    return false;
  }
  delete store.trusted[key];
  writeTrustStore(store);
  return true;
}

/** Check if a repo is trusted. */
export function isRepoTrusted(repoRoot: string): boolean {
  const store = readTrustStore();
  const key = normalizeRepoPath(repoRoot);
  return key in store.trusted;
}

/** List all trusted repos. */
export function listTrustedRepos(): { path: string; trustedAt: string }[] {
  const store = readTrustStore();
  return Object.entries(store.trusted).map(([path, data]) => ({
    path,
    trustedAt: data.trustedAt,
  }));
}

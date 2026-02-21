/**
 * Configuration loading and merging.
 *
 * Loads hierarchical .blobsy.yml files: built-in defaults <- ~/.blobsy.yml <- repo root
 * <- subdirectory overrides. Bottom-up resolution with shallow merge semantics.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { writeFile } from 'atomically';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { BlobsyConfig, ExternalizeConfig, CompressConfig } from './types.js';
import { ValidationError } from './types.js';
import { ensureDir } from './fs-utils.js';

const CONFIG_FILENAME = '.blobsy.yml';

/** Hardcoded built-in defaults compiled into blobsy. */
export function getBuiltinDefaults(): BlobsyConfig {
  return {
    externalize: {
      min_size: '1mb',
      always: [
        '*.parquet',
        '*.bin',
        '*.weights',
        '*.onnx',
        '*.safetensors',
        '*.pkl',
        '*.pt',
        '*.h5',
        '*.arrow',
        '*.sqlite',
        '*.db',
      ],
      never: [],
    },
    compress: {
      algorithm: 'zstd',
      min_size: '100kb',
      always: ['*.json', '*.csv', '*.tsv', '*.txt', '*.jsonl', '*.xml', '*.sql'],
      never: [
        '*.gz',
        '*.zst',
        '*.zip',
        '*.tar.*',
        '*.parquet',
        '*.png',
        '*.jpg',
        '*.jpeg',
        '*.mp4',
        '*.webp',
        '*.avif',
      ],
    },
    remote: {
      key_template: '{iso_date_secs}-{content_sha256_short}/{repo_path}{compress_suffix}',
    },
    sync: {
      tools: ['aws-cli', 'rclone'],
      parallel: 8,
    },
    checksum: {
      algorithm: 'sha256',
    },
    ignore: ['node_modules/**', '.git/**', '.blobsy/**', '*.tmp'],
  };
}

/** Parse a single .blobsy.yml file. */
export async function loadConfigFile(filePath: string): Promise<BlobsyConfig> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new ValidationError(`Cannot read config file: ${filePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new ValidationError(
      `Malformed YAML in config file: ${filePath}: ${(err as Error).message}`,
      ['Check that the .blobsy.yml file contains valid YAML.'],
    );
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== 'object') {
    throw new ValidationError(`Invalid config file (not an object): ${filePath}`);
  }

  validateConfigFields(parsed as Record<string, unknown>, filePath);

  return parsed as BlobsyConfig;
}

/**
 * Shallow merge: override replaces entire keys, no deep-merge.
 *
 * If a subdirectory specifies `externalize.always: ["*.parquet"]`, it completely
 * replaces the parent's `always` list.
 */
export function mergeConfigs(base: BlobsyConfig, override: Partial<BlobsyConfig>): BlobsyConfig {
  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}

/**
 * Walk up from target path, find all .blobsy.yml files, merge bottom-up.
 * Resolution order: built-in defaults <- ~/.blobsy.yml <- repo-root <- ... <- target dir
 */
export async function resolveConfig(targetPath: string, repoRoot: string): Promise<BlobsyConfig> {
  let config = getBuiltinDefaults();

  // User-global config
  const globalConfig = join(homedir(), CONFIG_FILENAME);
  if (existsSync(globalConfig)) {
    const globalOverride = await loadConfigFile(globalConfig);
    config = mergeConfigs(config, globalOverride);
  }

  // Collect config files from repo root up to target directory
  const configFiles: string[] = [];
  const targetDir = resolve(targetPath);
  let dir = targetDir;
  const repoRootResolved = resolve(repoRoot);

  while (dir.startsWith(repoRootResolved)) {
    const configPath = join(dir, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      configFiles.unshift(configPath);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  // Apply in order: repo root first, deepest subdirectory last
  for (const configPath of configFiles) {
    const override = await loadConfigFile(configPath);
    config = mergeConfigs(config, override);
  }

  return config;
}

function validateConfigFields(parsed: Record<string, unknown>, filePath: string): void {
  if (
    parsed.backends !== undefined &&
    (typeof parsed.backends !== 'object' || Array.isArray(parsed.backends))
  ) {
    throw new ValidationError(`Invalid "backends" in ${filePath}: expected an object`);
  }
  if (
    parsed.externalize !== undefined &&
    (typeof parsed.externalize !== 'object' || Array.isArray(parsed.externalize))
  ) {
    throw new ValidationError(`Invalid "externalize" in ${filePath}: expected an object`);
  }
  if (
    parsed.compress !== undefined &&
    (typeof parsed.compress !== 'object' || Array.isArray(parsed.compress))
  ) {
    throw new ValidationError(`Invalid "compress" in ${filePath}: expected an object`);
  }
  if (parsed.ignore !== undefined && !Array.isArray(parsed.ignore)) {
    throw new ValidationError(`Invalid "ignore" in ${filePath}: expected an array`);
  }
}

/** Write a .blobsy.yml config file. */
export async function writeConfigFile(
  filePath: string,
  config: Record<string, unknown>,
): Promise<void> {
  await ensureDir(dirname(filePath));
  const content = stringifyYaml(config, { lineWidth: 0 });
  await writeFile(filePath, content);
}

/** Get the config file path for a repo root. */
export function getConfigPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_FILENAME);
}

/** Parse a human-readable size string (e.g. "1mb", "100kb") to bytes. */
export function parseSize(size: string | number): number {
  if (typeof size === 'number') {
    return size;
  }

  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i.exec(size.trim());
  if (!match) {
    throw new ValidationError(`Invalid size format: ${size} (expected e.g. "1mb", "100kb")`);
  }

  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();

  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };

  return Math.floor(value * multipliers[unit]!);
}

/** Get the effective externalize config, using defaults if not specified. */
export function getExternalizeConfig(config: BlobsyConfig): ExternalizeConfig {
  const defaults = getBuiltinDefaults().externalize!;
  if (!config.externalize) {
    return defaults;
  }
  return {
    min_size: config.externalize.min_size ?? defaults.min_size,
    always: config.externalize.always ?? defaults.always,
    never: config.externalize.never ?? defaults.never,
  };
}

/** Get the effective compress config, using defaults if not specified. */
export function getCompressConfig(config: BlobsyConfig): CompressConfig {
  const defaults = getBuiltinDefaults().compress!;
  if (!config.compress) {
    return defaults;
  }
  return {
    algorithm: config.compress.algorithm ?? defaults.algorithm,
    min_size: config.compress.min_size ?? defaults.min_size,
    always: config.compress.always ?? defaults.always,
    never: config.compress.never ?? defaults.never,
  };
}

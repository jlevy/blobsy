#!/usr/bin/env node

/**
 * CLI entry point for blobsy.
 *
 * Commander.js-based CLI with all subcommands, global flags, and
 * dual-mode output (human-readable + JSON).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, Option } from 'commander';
import colors from 'picocolors';

import { parseBackendUrl, validateBackendUrl, resolveLocalPath } from './backend-url.js';
import {
  getConfigPath,
  getExternalizeConfig,
  getGlobalConfigPath,
  resolveConfig,
  resolveConfigWithOrigins,
  unsetNestedValue,
  writeConfigFile,
} from './config.js';
import { shouldExternalize } from './externalize.js';
import {
  isInteractive,
  renderMarkdown,
  paginateOutput,
  extractSections,
  findSection,
} from './markdown-output.js';
import {
  formatDryRun,
  formatError,
  formatJson,
  formatJsonDryRun,
  formatJsonError,
  formatJsonMessage,
  formatSize,
} from './format.js';
import { ensureDir } from './fs-utils.js';
import { addGitignoreEntry, removeGitignoreEntry } from './gitignore.js';
import { computeHash } from './hash.js';
import {
  findRepoRoot,
  findBrefFiles,
  findTrackableFiles,
  isDirectory,
  normalizePath,
  resolveFilePath,
  stripBrefExtension,
  toRepoRelative,
  brefPath,
} from './paths.js';
import { readBref, writeBref } from './ref.js';
import {
  getGlobalOpts,
  handlePush,
  handlePull,
  handleSync,
  handleHealth,
  handleDoctor,
  handleHooks,
  handleCheckUnpushed,
  handlePrePushCheck,
  handleHook,
  resolveTrackedFiles,
} from './commands-stage2.js';
import { createCacheEntry, getStatCacheDir, writeCacheEntry } from './stat-cache.js';
import { SKILL_TEXT } from './skill-text.js';
import type { BlobsyConfig, GlobalOptions, Bref } from './types.js';
import {
  BlobsyError,
  FILE_STATE_SYMBOLS,
  BREF_FORMAT,
  ValidationError,
  UserError,
} from './types.js';

function createProgram(): Command {
  const program = new Command();

  program
    .name('blobsy')
    .description('Store large files anywhere. Track them in Git.')
    .version(getVersion(), '--version', 'Show version number')
    .helpOption('-h, --help', 'Display help for command')
    .addOption(new Option('--json', 'Structured JSON output').hideHelp(false).preset(true))
    .addOption(
      new Option('--quiet', 'Suppress all output except errors').hideHelp(false).preset(true),
    )
    .addOption(new Option('--verbose', 'Detailed progress output').hideHelp(false).preset(true))
    .addOption(
      new Option('--dry-run', 'Show what would happen without doing it')
        .hideHelp(false)
        .preset(true),
    )
    .configureHelp({
      helpWidth: Math.min(88, process.stdout.columns ?? 80),
      showGlobalOptions: true,
      styleTitle: (str: string) => colors.bold(colors.cyan(str)),
      styleCommandText: (str: string) => colors.green(str),
      styleOptionText: (str: string) => colors.yellow(str),
    })
    .showHelpAfterError('(use --help for usage, or blobsy docs for full guide)');

  program
    .command('setup')
    .description('Set up blobsy in a git repo (wraps init + agent integration)')
    .argument('<url>', 'Backend URL (e.g. s3://bucket/prefix/, local:../path)')
    .option('--auto', 'Non-interactive setup (recommended)')
    .option('--region <region>', 'AWS region (for S3 backends)')
    .option('--endpoint <endpoint>', 'Custom S3-compatible endpoint URL')
    .option('--no-hooks', 'Skip git hook installation')
    .action(wrapAction(handleSetup));

  program
    .command('init')
    .description('Initialize blobsy config (low-level; prefer setup --auto)')
    .argument('<url>', 'Backend URL (e.g. s3://bucket/prefix/, local:../path)')
    .option('--region <region>', 'AWS region (for S3 backends)')
    .option('--endpoint <endpoint>', 'Custom S3-compatible endpoint URL')
    .option('--no-hooks', 'Skip git hook installation')
    .action(wrapAction(handleInit));

  program
    .command('add')
    .description('Track files and stage changes to git (recommended)')
    .argument('<path...>', 'Files or directories to add')
    .option('--force', 'Skip confirmation for destructive operations')
    .option(
      '--min-size <size>',
      'Override minimum file size for directory tracking (e.g. "100kb", "5mb")',
    )
    .action(wrapAction(handleAdd));

  program
    .command('track')
    .description('Start tracking files or directories with .bref pointers')
    .argument('<path...>', 'Files or directories to track')
    .option('--force', 'Skip confirmation for destructive operations')
    .option(
      '--min-size <size>',
      'Override minimum file size for directory tracking (e.g. "100kb", "5mb")',
    )
    .action(wrapAction(handleTrack));

  program
    .command('untrack')
    .description('Stop tracking files (keeps local files, moves .bref to trash)')
    .argument('<path...>', 'Files or directories to untrack')
    .option('--recursive', 'Required for directory removal')
    .action(wrapAction(handleUntrack));

  program
    .command('rm')
    .description('Remove tracked files: delete local + move .bref to trash')
    .argument('<path...>', 'Files or directories to remove')
    .option('--local', 'Delete local file only, keep .bref and remote')
    .option('--remote', 'Also delete blob from backend (requires confirmation)')
    .option('--force', 'Skip confirmation prompts')
    .option('--recursive', 'Required for directory removal')
    .action(wrapAction(handleRm));

  program
    .command('mv')
    .description('Rename or move tracked files or directories (updates .bref + .gitignore)')
    .argument('<source>', 'Source tracked file or directory')
    .argument('<dest>', 'Destination path')
    .action(wrapAction(handleMv));

  program
    .command('push')
    .description('Upload local blobs to the configured backend')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--force', 'Re-push even if remote exists')
    .action(wrapAction(handlePush));

  program
    .command('pull')
    .description('Download blobs from the configured backend')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--force', 'Overwrite local modifications')
    .action(wrapAction(handlePull));

  program
    .command('sync')
    .description('Bidirectional sync: push unpushed + pull missing')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--skip-health-check', 'Skip backend health check')
    .option('--force', 'Force sync (overwrite conflicts)')
    .action(wrapAction(handleSync));

  program
    .command('status')
    .description('Show sync state of tracked files')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--json', 'Structured JSON output')
    .action(wrapAction(handleStatus));

  program
    .command('verify')
    .description('Verify local files match their .bref hashes')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .option('--json', 'Structured JSON output')
    .action(wrapAction(handleVerify));

  program
    .command('config')
    .description('Show, get, or set .blobsy.yml values')
    .argument('[key]', 'Config key (dot-separated, e.g. compress.algorithm)')
    .argument('[value]', 'Value to set')
    .option('--global', 'Use global config (~/.blobsy.yml)')
    .option('--show-origin', 'Show which config file each value comes from')
    .option('--unset', 'Remove the specified config key')
    .action(wrapAction(handleConfig));

  program
    .command('health')
    .description('Test backend connectivity and permissions')
    .action(wrapAction(handleHealth));

  program
    .command('doctor')
    .description('Run diagnostics and optionally auto-fix issues')
    .option('--fix', 'Attempt to automatically fix detected issues')
    .option('--json', 'Structured JSON output')
    .option('--verbose', 'Show detailed diagnostic logs')
    .action(wrapAction(handleDoctor));

  program
    .command('hooks')
    .description('Install or uninstall blobsy git hooks (pre-commit, pre-push)')
    .argument('<action>', 'install or uninstall')
    .action(wrapAction(handleHooks));

  program
    .command('check-unpushed')
    .description('List committed .bref files whose blobs are not yet pushed')
    .action(wrapAction(handleCheckUnpushed));

  program
    .command('pre-push-check')
    .description('CI guard: fail if any .bref is missing its remote blob')
    .action(wrapAction(handlePrePushCheck));

  program
    .command('hook', { hidden: true })
    .description('Internal hook commands')
    .argument('<type>', 'Hook type (pre-commit, pre-push)')
    .action(wrapAction(handleHook));

  program
    .command('readme')
    .description('Display the blobsy README')
    .action(
      wrapAction(async (opts: Record<string, unknown>) => {
        const content = await loadBundledDoc('README.md');
        const interactive = isInteractive(opts);
        const rendered = renderMarkdown(content, interactive);
        await paginateOutput(rendered, interactive);
      }),
    );

  program
    .command('docs')
    .description('Display blobsy user documentation')
    .argument('[topic]', 'Section to display (e.g. "compression", "backends")')
    .option('--list', 'List available sections')
    .option('--brief', 'Condensed version')
    .action(
      wrapAction(async (topic: string | undefined, opts: Record<string, unknown>) => {
        const interactive = isInteractive(opts);

        if (opts.brief) {
          const brief = await loadBundledDoc('blobsy-docs-brief.md');
          const rendered = renderMarkdown(brief, interactive);
          await paginateOutput(rendered, interactive);
          return;
        }

        let content = await loadBundledDoc('blobsy-docs.md');
        const sections = extractSections(content);

        if (opts.list) {
          console.log('Available documentation sections:\n');
          for (const s of sections) {
            console.log(`  ${s.slug.padEnd(28)} ${s.title}`);
          }
          console.log(`\nUse: blobsy docs <topic>`);
          return;
        }

        if (topic) {
          const section = findSection(content, sections, topic);
          if (!section) {
            console.error(`Section "${topic}" not found. Use --list to see available sections.`);
            process.exitCode = 1;
            return;
          }
          content = section;
        }

        const rendered = renderMarkdown(content, interactive);
        await paginateOutput(rendered, interactive);
      }),
    );

  program
    .command('skill')
    .description('Output blobsy skill documentation (for AI agents)')
    .action(
      // eslint-disable-next-line @typescript-eslint/require-await
      wrapAction(async () => {
        console.log(SKILL_TEXT);
      }),
    );

  program.addHelpText('after', () => {
    return [
      '',
      colors.bold('Get started:'),
      `  ${colors.green('blobsy setup --auto')} s3://bucket/prefix/`,
      `  ${colors.green('blobsy add')} <file-or-dir>`,
      `  ${colors.green('blobsy push')}`,
      '',
      colors.bold('Learn more:'),
      `  ${colors.green('blobsy readme')}              Overview and quick start`,
      `  ${colors.green('blobsy docs')}                Full user guide`,
      `  ${colors.green('blobsy docs')} ${colors.yellow('<topic>')}        Specific topic (try ${colors.yellow('"backends"')}, ${colors.yellow('"compression"')})`,
      `  ${colors.green('blobsy docs --list')}          List all topics`,
      `  ${colors.green('blobsy skill')}               Quick reference for AI agents`,
      '',
      `${colors.dim('https://github.com/jlevy/blobsy')}`,
    ].join('\n');
  });

  return program;
}

function getVersion(): string {
  return '0.1.0';
}

/**
 * Load a bundled documentation file from dist/docs/ with dev fallback.
 */
async function loadBundledDoc(filename: string): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Production: dist/docs/<filename>
  try {
    return await readFile(join(__dirname, 'docs', filename), 'utf-8');
  } catch {
    // Dev fallback: packages/blobsy/docs/<filename>
    try {
      return await readFile(join(__dirname, '..', 'docs', filename), 'utf-8');
    } catch {
      // Last fallback for README: repo root
      if (filename === 'README.md') {
        return await readFile(join(__dirname, '..', '..', '..', 'README.md'), 'utf-8');
      }
      throw new Error(`Documentation file not found: ${filename}`);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionHandler = (...args: any[]) => Promise<void>;

/**
 * Wrap a command action with error handling and JSON output.
 */
function wrapAction(handler: ActionHandler): ActionHandler {
  return async (...args: unknown[]) => {
    try {
      const cmd = args.find((a) => a instanceof Command);
      if (cmd) {
        const g = getGlobalOpts(cmd);
        if (g.quiet && g.verbose) {
          throw new ValidationError('--quiet and --verbose cannot be used together.');
        }
      }
      await handler(...args);
    } catch (err) {
      const cmd = args.find((a) => a instanceof Command);
      const globalOpts = cmd
        ? getGlobalOpts(cmd)
        : { json: false, quiet: false, verbose: false, dryRun: false };

      if (err instanceof UserError) {
        // User-friendly errors with hints
        if (globalOpts.json) {
          console.error(formatJsonError(err));
        } else {
          console.error(err.format());
        }
        process.exitCode = err.exitCode;
      } else if (err instanceof BlobsyError) {
        if (globalOpts.json) {
          console.error(formatJsonError(err));
        } else {
          console.error(formatError(err));
        }
        process.exitCode = err.exitCode;
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        if (globalOpts.json) {
          console.error(formatJsonError(error));
        } else {
          console.error(`Error: ${error.message}`);
        }
        process.exitCode = 1;
      }
    }
  };
}

// --- Command Handlers ---

async function handleSetup(
  url: string,
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);

  if (!opts.auto) {
    throw new UserError('--auto flag is required (interactive setup is not yet supported)');
  }

  // Delegate to init
  await handleInit(url, opts, cmd);

  // Install agent integration files
  const repoRoot = findRepoRoot();
  if (!globalOpts.dryRun) {
    await installAgentFiles(repoRoot, globalOpts);
  }

  // Show next steps (unless quiet/json)
  if (!globalOpts.quiet && !globalOpts.json) {
    console.log('');
    console.log('Setup complete! Next steps:');
    console.log('  blobsy track <file>    Track files with .bref pointers');
    console.log('  blobsy push            Upload to backend');
    console.log('  blobsy status          Check sync state');
    console.log('  blobsy skill           Quick reference for AI agents');
  }
}

// --- Agent Integration ---

const BLOBSY_SKILL_REL = '.claude/skills/blobsy/SKILL.md';
const AGENTS_MD_REL = 'AGENTS.md';
const AGENTS_MD_BEGIN = '<!-- BEGIN BLOBSY INTEGRATION -->';
const AGENTS_MD_END = '<!-- END BLOBSY INTEGRATION -->';

/**
 * Install agent integration files if agent tooling is detected.
 * - .claude/skills/blobsy/SKILL.md (if Claude Code detected)
 * - AGENTS.md section (if AGENTS.md exists)
 */
async function installAgentFiles(repoRoot: string, globalOpts: GlobalOptions): Promise<void> {
  await installClaudeSkill(repoRoot, globalOpts);
  await installAgentsMdSection(repoRoot, globalOpts);
}

/**
 * Install .claude/skills/blobsy/SKILL.md if Claude Code is detected.
 * Detection: ~/.claude/ exists, or .claude/ exists in project, or CLAUDE_* env vars.
 */
async function installClaudeSkill(repoRoot: string, globalOpts: GlobalOptions): Promise<void> {
  const globalClaudeDir = join(homedir(), '.claude');
  const projectClaudeDir = join(repoRoot, '.claude');
  const hasClaudeGlobal = existsSync(globalClaudeDir);
  const hasClaudeProject = existsSync(projectClaudeDir);
  const hasClaudeEnv = Object.keys(process.env).some((k) => k.startsWith('CLAUDE_'));

  if (!hasClaudeGlobal && !hasClaudeProject && !hasClaudeEnv) {
    return;
  }

  const skillPath = join(repoRoot, BLOBSY_SKILL_REL);
  const skillDir = dirname(skillPath);

  // Always write (idempotent update to latest content)
  await ensureDir(skillDir);
  await writeFile(skillPath, SKILL_TEXT);

  if (!globalOpts.quiet && !globalOpts.json) {
    console.log(`Installed ${BLOBSY_SKILL_REL}`);
  }
}

/**
 * Add or update blobsy section in AGENTS.md if it exists.
 * Uses markers to allow idempotent updates.
 */
async function installAgentsMdSection(repoRoot: string, globalOpts: GlobalOptions): Promise<void> {
  const agentsPath = join(repoRoot, AGENTS_MD_REL);

  if (!existsSync(agentsPath)) {
    return;
  }

  const section = [
    AGENTS_MD_BEGIN,
    '## Blobsy',
    '',
    'Git-native large file storage CLI.',
    '',
    '**Installation:** `npm install -g blobsy@latest`',
    '**Setup:** `blobsy setup --auto s3://bucket/prefix/`',
    '**Orientation:** Run `blobsy skill` for quick reference',
    AGENTS_MD_END,
  ].join('\n');

  let content = await readFile(agentsPath, 'utf-8');

  if (content.includes(AGENTS_MD_BEGIN)) {
    // Replace existing section
    const beginIdx = content.indexOf(AGENTS_MD_BEGIN);
    const endIdx = content.indexOf(AGENTS_MD_END);
    if (endIdx > beginIdx) {
      content = content.slice(0, beginIdx) + section + content.slice(endIdx + AGENTS_MD_END.length);
      await writeFile(agentsPath, content);
      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(`Updated blobsy section in ${AGENTS_MD_REL}`);
      }
    }
  } else {
    // Append section
    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    content += separator + section + '\n';
    await writeFile(agentsPath, content);
    if (!globalOpts.quiet && !globalOpts.json) {
      console.log(`Added blobsy section to ${AGENTS_MD_REL}`);
    }
  }
}

async function handleInit(url: string, opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const configPath = getConfigPath(repoRoot);

  const parsed = parseBackendUrl(url);
  validateBackendUrl(parsed, repoRoot);

  // Auto-create local backend directory if it doesn't exist
  if (parsed.type === 'local' && parsed.path) {
    const absPath = resolveLocalPath(parsed.path, repoRoot);

    if (!existsSync(absPath)) {
      try {
        // Create backend directory (with all parent directories if needed)
        await ensureDir(absPath);

        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(
            `Created backend directory: ${normalizePath(toRepoRelative(absPath, repoRoot))}`,
          );
        }
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        const parentDir = dirname(absPath);

        if (error.code === 'ENOENT') {
          // This shouldn't happen with recursive: true, but just in case
          throw new ValidationError(
            `Cannot create backend directory: ${absPath}\n` +
              `  Parent directory does not exist: ${parentDir}\n` +
              `  Create parent first: mkdir -p ${parentDir}`,
          );
        }

        if (error.code === 'EACCES') {
          throw new ValidationError(
            `Permission denied creating backend directory: ${absPath}\n` +
              `  Check directory permissions`,
          );
        }

        throw error; // Re-throw unexpected errors
      }
    }
  }

  if (globalOpts.dryRun) {
    const actions = [];
    if (!existsSync(configPath)) {
      actions.push(`create ${normalizePath(toRepoRelative(configPath, repoRoot))}`);
    }
    actions.push('install pre-commit hook');
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const a of actions) {
        console.log(formatDryRun(a));
      }
    }
    return;
  }

  if (existsSync(configPath)) {
    if (!globalOpts.quiet) {
      const msg = `Config already exists at ${normalizePath(toRepoRelative(configPath, repoRoot))}. Skipping config creation.`;
      if (globalOpts.json) {
        console.log(formatJsonMessage(msg));
      } else {
        console.log(msg);
      }
    }
  } else {
    const config: Record<string, unknown> = {
      backends: {
        default: {
          url,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        },
      },
    };

    await writeConfigFile(configPath, config);

    if (!globalOpts.quiet) {
      const msg = `Initialized blobsy in ${normalizePath(toRepoRelative(repoRoot, repoRoot)) || '.'}`;
      if (globalOpts.json) {
        console.log(formatJsonMessage(msg));
      } else {
        console.log(msg);
        console.log(`Created ${normalizePath(toRepoRelative(configPath, repoRoot))}`);
      }
    }
  }

  // Install git hooks (pre-commit and pre-push)
  if (!opts.noHooks) {
    await installHooks(repoRoot, globalOpts);
  }
}

const HOOKS = [
  { name: 'pre-commit', gitEvent: 'pre-commit' },
  { name: 'pre-push', gitEvent: 'pre-push' },
] as const;

async function installHooks(repoRoot: string, globalOpts: GlobalOptions): Promise<void> {
  if (process.env.BLOBSY_NO_HOOKS) return;

  const hookDir = join(repoRoot, '.git', 'hooks');

  // Check for hook managers
  if (existsSync(join(repoRoot, 'lefthook.yml')) || existsSync(join(repoRoot, '.husky'))) {
    if (!globalOpts.quiet && !globalOpts.json) {
      console.log('Hook manager detected. Add blobsy hooks to your hook configuration:');
      console.log('  pre-commit: blobsy hook pre-commit');
      console.log('  pre-push:   blobsy hook pre-push');
    }
    return;
  }

  await ensureDir(hookDir);
  const { writeFile: writeFs, chmod } = await import('node:fs/promises');

  for (const hook of HOOKS) {
    const hookPath = join(hookDir, hook.name);

    if (existsSync(hookPath)) {
      const content = await readFile(hookPath, 'utf-8');
      if (!content.includes('blobsy')) {
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(
            `Existing ${hook.name} hook found. Add manually: blobsy hook ${hook.gitEvent}`,
          );
        }
        continue;
      }
    }

    const hookContent = `#!/bin/sh\n# Installed by: blobsy hooks install\n# To bypass: git ${hook.name === 'pre-commit' ? 'commit' : 'push'} --no-verify\nexec blobsy hook ${hook.gitEvent}\n`;
    await writeFs(hookPath, hookContent);
    await chmod(hookPath, 0o755);

    if (!globalOpts.quiet && !globalOpts.json) {
      console.log(`Installed ${hook.name} hook.`);
    }
  }
}

async function handleTrack(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const cacheDir = getStatCacheDir(repoRoot);
  const config = await resolveConfig(repoRoot, repoRoot);
  const minSizeOverride = opts.minSize as string | undefined;

  for (const inputPath of paths) {
    const absPath = resolveFilePath(stripBrefExtension(inputPath));

    if (isDirectory(absPath)) {
      await trackDirectory(absPath, repoRoot, cacheDir, config, globalOpts, minSizeOverride);
    } else {
      await trackSingleFile(absPath, repoRoot, cacheDir, globalOpts);
    }
  }
}

async function handleAdd(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();
  const cacheDir = getStatCacheDir(repoRoot);
  const config = await resolveConfig(repoRoot, repoRoot);
  const minSizeOverride = opts.minSize as string | undefined;

  const allFilesToStage: string[] = [];

  for (const inputPath of paths) {
    const absPath = resolveFilePath(stripBrefExtension(inputPath));
    let result: TrackResult;
    if (isDirectory(absPath)) {
      result = await trackDirectory(
        absPath,
        repoRoot,
        cacheDir,
        config,
        globalOpts,
        minSizeOverride,
      );
    } else {
      result = await trackSingleFile(absPath, repoRoot, cacheDir, globalOpts);
    }
    allFilesToStage.push(...result.filesToStage);
  }

  // Deduplicate
  const uniqueFiles = [...new Set(allFilesToStage)];

  // Stage to git
  if (!globalOpts.dryRun && uniqueFiles.length > 0) {
    execFileSync('git', ['add', '--', ...uniqueFiles], {
      cwd: repoRoot,
      stdio: 'pipe',
    });

    if (!globalOpts.quiet && !globalOpts.json) {
      const brefCount = uniqueFiles.filter((f) => f.endsWith('.bref')).length;
      const gitignoreCount = uniqueFiles.filter((f) => basename(f) === '.gitignore').length;
      const keptCount = uniqueFiles.length - brefCount - gitignoreCount;
      const parts = [];
      if (brefCount > 0) {
        parts.push(`${brefCount} .bref`);
      }
      if (gitignoreCount > 0) {
        parts.push(`${gitignoreCount} .gitignore`);
      }
      if (keptCount > 0) {
        parts.push(`${keptCount} kept in git`);
      }
      console.log(`Staged ${uniqueFiles.length} files (${parts.join(', ')}).`);
      console.log(
        'Changes have been staged to git: run `git status` to review and `git commit` to commit.',
      );
    }
  }
}

interface TrackResult {
  /** Absolute paths of files to git-add */
  filesToStage: string[];
  /** Count of files externalized (got .bref) */
  externalized: number;
  /** Count of files unchanged (already tracked, same hash) */
  unchanged: number;
  /** Count of non-externalized files found during directory walk */
  keptInGit: number;
}

function emptyTrackResult(): TrackResult {
  return { filesToStage: [], externalized: 0, unchanged: 0, keptInGit: 0 };
}

async function trackSingleFile(
  absPath: string,
  repoRoot: string,
  cacheDir: string,
  globalOpts: GlobalOptions,
): Promise<TrackResult> {
  const result = emptyTrackResult();
  const relPath = toRepoRelative(absPath, repoRoot);
  const refPath = brefPath(absPath);
  const refRelPath = toRepoRelative(refPath, repoRoot);
  const fileDir = dirname(absPath);
  const fileName = basename(absPath);

  if (!existsSync(absPath)) {
    throw new ValidationError(`File not found: ${relPath}`, ['Check the file path and try again.']);
  }

  if (globalOpts.dryRun) {
    const action = existsSync(refPath) ? `update ${refRelPath}` : `track ${relPath}`;
    if (globalOpts.json) {
      console.log(formatJsonDryRun([action]));
    } else {
      console.log(formatDryRun(action));
    }
    return result;
  }

  const hash = await computeHash(absPath);
  const fileStat = statSync(absPath);
  const fileSize = fileStat.size;

  // Check for existing ref
  if (existsSync(refPath)) {
    const existingRef = await readBref(refPath);
    if (existingRef.hash === hash) {
      if (!globalOpts.quiet) {
        if (globalOpts.json) {
          console.log(formatJsonMessage(`${relPath} already tracked (unchanged)`));
        } else {
          console.log(`${relPath} already tracked (unchanged)`);
        }
      }
      result.unchanged++;
      return result;
    }

    // Hash changed, update. Clear remote_key since old key points to old content.
    const newRef: Bref = {
      ...existingRef,
      hash,
      size: fileSize,
      remote_key: undefined,
      compressed: undefined,
      compressed_size: undefined,
    };
    await writeBref(refPath, newRef);

    // Update stat cache
    const entry = await createCacheEntry(absPath, relPath, hash);
    await writeCacheEntry(cacheDir, entry);

    if (!globalOpts.quiet) {
      if (globalOpts.json) {
        console.log(formatJsonMessage(`Updated ${refRelPath} (hash changed)`));
      } else {
        console.log(`Updated ${refRelPath} (hash changed)`);
      }
    }
    result.externalized++;
    const gitignorePath = join(fileDir, '.gitignore');
    result.filesToStage.push(refPath, gitignorePath);
    return result;
  }

  // New tracking
  const ref: Bref = {
    format: BREF_FORMAT,
    hash,
    size: fileSize,
  };
  await writeBref(refPath, ref);

  // Add to gitignore
  await addGitignoreEntry(fileDir, fileName);

  // Write stat cache
  const entry = await createCacheEntry(absPath, relPath, hash);
  await writeCacheEntry(cacheDir, entry);

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Tracking ${relPath}`));
    } else {
      console.log(`Tracking ${relPath}`);
      console.log(`Created ${refRelPath}`);
      console.log(`Added ${relPath} to .gitignore`);
    }
  }

  result.externalized++;
  const gitignorePath = join(fileDir, '.gitignore');
  result.filesToStage.push(refPath, gitignorePath);
  return result;
}

async function trackDirectory(
  absDir: string,
  repoRoot: string,
  cacheDir: string,
  config: BlobsyConfig,
  globalOpts: GlobalOptions,
  minSizeOverride?: string,
): Promise<TrackResult> {
  const result = emptyTrackResult();
  const relDir = toRepoRelative(absDir, repoRoot);
  const files = findTrackableFiles(absDir, config.ignore);
  const baseExtConfig = getExternalizeConfig(config);
  const extConfig = minSizeOverride
    ? { ...baseExtConfig, min_size: minSizeOverride }
    : baseExtConfig;

  if (globalOpts.dryRun) {
    const trackable = files.filter((f) => {
      const rel = toRepoRelative(f, repoRoot);
      const sz = statSync(f).size;
      return shouldExternalize(rel, sz, extConfig);
    });
    if (globalOpts.json) {
      console.log(formatJsonDryRun(trackable.map((f) => `track ${toRepoRelative(f, repoRoot)}`)));
    } else {
      console.log(
        formatDryRun(
          `track ${trackable.length} file${trackable.length === 1 ? '' : 's'} in ${relDir}/`,
        ),
      );
    }
    return result;
  }

  if (!globalOpts.quiet && !globalOpts.json) {
    console.log(`Scanning ${relDir}/...`);
  }

  for (const absFilePath of files) {
    const relFilePath = toRepoRelative(absFilePath, repoRoot);
    const fileStat = statSync(absFilePath);
    const fileSize = fileStat.size;

    if (!shouldExternalize(relFilePath, fileSize, extConfig)) {
      result.keptInGit++;
      result.filesToStage.push(absFilePath);
      continue;
    }

    const refPath = brefPath(absFilePath);
    const hash = await computeHash(absFilePath);
    const fileName = basename(absFilePath);
    const fileDir = dirname(absFilePath);
    const sizeStr = formatSize(fileSize).padStart(6);

    if (existsSync(refPath)) {
      const existingRef = await readBref(refPath);
      if (existingRef.hash === hash) {
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(
            `  ${relFilePath}${' '.repeat(Math.max(1, 22 - relFilePath.length))}(${sizeStr})  -> already tracked (unchanged)`,
          );
        }
        result.unchanged++;
        continue;
      }

      const newRef: Bref = { ...existingRef, hash, size: fileSize };
      await writeBref(refPath, newRef);
      const cacheEntry = await createCacheEntry(absFilePath, relFilePath, hash);
      await writeCacheEntry(cacheDir, cacheEntry);

      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(
          `  ${relFilePath}${' '.repeat(Math.max(1, 22 - relFilePath.length))}(${sizeStr})  -> updated (hash changed)`,
        );
      }
      result.externalized++;
      const gitignorePath = join(fileDir, '.gitignore');
      result.filesToStage.push(refPath, gitignorePath);
    } else {
      const ref: Bref = { format: BREF_FORMAT, hash, size: fileSize };
      await writeBref(refPath, ref);
      await addGitignoreEntry(fileDir, fileName);
      const cacheEntry = await createCacheEntry(absFilePath, relFilePath, hash);
      await writeCacheEntry(cacheDir, cacheEntry);

      if (!globalOpts.quiet && !globalOpts.json) {
        console.log(
          `  ${relFilePath}${' '.repeat(Math.max(1, 22 - relFilePath.length))}(${sizeStr})  -> tracked`,
        );
      }
      result.externalized++;
      const gitignorePath = join(fileDir, '.gitignore');
      result.filesToStage.push(refPath, gitignorePath);
    }
  }

  if (!globalOpts.quiet && !globalOpts.json) {
    const parts: string[] = [];
    if (result.externalized > 0) {
      parts.push(`${result.externalized} file${result.externalized === 1 ? '' : 's'} tracked`);
    } else {
      parts.push('0 files tracked');
    }
    if (result.unchanged > 0) {
      parts.push(`${result.unchanged} unchanged`);
    }
    console.log(`${parts.join(', ')}.`);
  }

  // Deduplicate filesToStage (multiple files in same dir -> same .gitignore)
  result.filesToStage = [...new Set(result.filesToStage)];
  return result;
}

async function handleStatus(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const useJson = Boolean(opts.json) || globalOpts.json;
  const repoRoot = findRepoRoot();

  const files = resolveTrackedFiles(paths, repoRoot);

  if (files.length === 0) {
    if (useJson) {
      console.log(formatJson({ files: [], summary: { total: 0 } }));
    } else {
      console.log('No tracked files found.');
    }
    return;
  }

  const results: {
    path: string;
    symbol: string;
    state: string;
    details: string;
  }[] = [];

  for (const file of files) {
    const { symbol, state, details } = await getFileState(file.absPath, file.refPath, file.relPath);
    results.push({ path: file.relPath, symbol, state, details });
  }

  if (useJson) {
    console.log(
      formatJson({
        files: results.map((r) => ({
          path: r.path,
          state: r.state,
          details: r.details,
        })),
        summary: {
          total: results.length,
        },
      }),
    );
  } else {
    for (const r of results) {
      console.log(`  ${r.symbol}  ${r.path}  ${r.details}`);
    }
    console.log('');
    console.log(`${results.length} tracked file${results.length === 1 ? '' : 's'}`);
  }
}

async function getFileState(
  absPath: string,
  refPath: string,
  _relPath: string,
): Promise<{ symbol: string; state: string; details: string }> {
  if (!existsSync(refPath)) {
    return { symbol: FILE_STATE_SYMBOLS.missing, state: 'missing_ref', details: '.bref not found' };
  }

  const ref = await readBref(refPath);

  if (!existsSync(absPath)) {
    return { symbol: FILE_STATE_SYMBOLS.missing, state: 'missing_file', details: 'file missing' };
  }

  const currentHash = await computeHash(absPath);

  if (currentHash !== ref.hash) {
    return { symbol: FILE_STATE_SYMBOLS.modified, state: 'modified', details: 'modified' };
  }

  if (ref.remote_key) {
    // Check if .bref is committed (simplified: check if in git)
    return { symbol: FILE_STATE_SYMBOLS.synced, state: 'synced', details: 'synced' };
  }

  // No remote_key: not pushed yet
  // Simplified check: if .bref is committed
  return { symbol: FILE_STATE_SYMBOLS.new, state: 'new', details: 'not pushed' };
}

async function handleVerify(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const useJson = Boolean(opts.json) || globalOpts.json;
  const repoRoot = findRepoRoot();

  const files = resolveTrackedFiles(paths, repoRoot);

  let hasIssues = false;
  const results: { path: string; status: string; expected?: string; actual?: string }[] = [];

  for (const file of files) {
    if (!existsSync(file.refPath)) {
      results.push({ path: file.relPath, status: 'missing_ref' });
      hasIssues = true;
      continue;
    }

    const ref = await readBref(file.refPath);

    if (!existsSync(file.absPath)) {
      results.push({ path: file.relPath, status: 'missing' });
      hasIssues = true;
      continue;
    }

    const currentHash = await computeHash(file.absPath);
    if (currentHash !== ref.hash) {
      results.push({
        path: file.relPath,
        status: 'mismatch',
        expected: ref.hash,
        actual: currentHash,
      });
      hasIssues = true;
    } else {
      results.push({ path: file.relPath, status: 'ok' });
    }
  }

  if (useJson) {
    console.log(formatJson({ files: results, ok: !hasIssues }));
  } else {
    for (const r of results) {
      const statusStr = r.status === 'ok' ? 'ok' : r.status;
      console.log(`  ${r.status === 'ok' ? '\u2713' : '\u2717'}  ${r.path}  ${statusStr}`);
    }
    if (hasIssues) {
      console.log('');
      console.log('Verification failed.');
    } else {
      console.log('');
      console.log('All files verified.');
    }
  }

  if (hasIssues) {
    process.exitCode = 1;
  }
}

async function handleUntrack(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const recursive = Boolean(opts.recursive);
  const repoRoot = findRepoRoot();

  for (const inputPath of paths) {
    const absPath = resolveFilePath(stripBrefExtension(inputPath));

    if (isDirectory(absPath)) {
      if (!recursive) {
        throw new ValidationError(
          `${toRepoRelative(absPath, repoRoot)} is a directory. Use --recursive to untrack all files in it.`,
        );
      }
      const brefFiles = findBrefFiles(absPath, repoRoot);
      for (const rel of brefFiles) {
        await untrackFile(join(repoRoot, rel), repoRoot, globalOpts);
      }
    } else {
      await untrackFile(absPath, repoRoot, globalOpts);
    }
  }
}

async function untrackFile(
  absPath: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
): Promise<void> {
  const relPath = toRepoRelative(absPath, repoRoot);
  const refPath = brefPath(absPath);
  const fileName = basename(absPath);
  const fileDir = dirname(absPath);

  if (!existsSync(refPath)) {
    throw new ValidationError(`Not tracked: ${relPath} (no .bref file found)`);
  }

  if (globalOpts.dryRun) {
    if (globalOpts.json) {
      console.log(formatJsonDryRun([`untrack ${relPath}`]));
    } else {
      console.log(formatDryRun(`untrack ${relPath}`));
    }
    return;
  }

  // Move .bref to trash
  const trashDir = join(repoRoot, '.blobsy', 'trash');
  await ensureDir(trashDir);
  const trashPath = join(trashDir, `${basename(refPath)}.${Date.now()}`);
  await rename(refPath, trashPath);

  // Remove from gitignore
  await removeGitignoreEntry(fileDir, fileName);

  // Clean stat cache
  const cacheDir = getStatCacheDir(repoRoot);
  const { deleteCacheEntry } = await import('./stat-cache.js');
  await deleteCacheEntry(cacheDir, relPath);

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Untracked ${relPath}`));
    } else {
      console.log(`Untracked ${relPath}`);
      console.log(`Moved ${toRepoRelative(refPath, repoRoot)} to trash`);
    }
  }
}

async function handleRm(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const localOnly = Boolean(opts.local);
  const deleteRemote = Boolean(opts.remote);
  const force = Boolean(opts.force);
  const recursive = Boolean(opts.recursive);
  const repoRoot = findRepoRoot();

  // Validate flag combinations
  if (localOnly && deleteRemote) {
    throw new ValidationError('Cannot use both --local and --remote flags');
  }

  for (const inputPath of paths) {
    const absPath = resolveFilePath(stripBrefExtension(inputPath));

    if (isDirectory(absPath)) {
      if (!recursive) {
        throw new ValidationError(
          `${toRepoRelative(absPath, repoRoot)} is a directory. Use --recursive to remove all files in it.`,
        );
      }
      const brefFiles = findBrefFiles(absPath, repoRoot);
      for (const rel of brefFiles) {
        await rmFile(join(repoRoot, rel), repoRoot, localOnly, deleteRemote, force, globalOpts);
      }
    } else {
      await rmFile(absPath, repoRoot, localOnly, deleteRemote, force, globalOpts);
    }
  }
}

async function rmFile(
  absPath: string,
  repoRoot: string,
  localOnly: boolean,
  deleteRemote: boolean,
  force: boolean,
  globalOpts: GlobalOptions,
): Promise<void> {
  const relPath = toRepoRelative(absPath, repoRoot);
  const refPath = brefPath(absPath);
  const fileName = basename(absPath);
  const fileDir = dirname(absPath);

  if (globalOpts.dryRun) {
    const action = localOnly ? `delete local file ${relPath}` : `remove ${relPath}`;
    if (globalOpts.json) {
      console.log(formatJsonDryRun([action]));
    } else {
      console.log(formatDryRun(action));
    }
    return;
  }

  if (localOnly) {
    // Just delete local file, keep .bref
    if (existsSync(absPath)) {
      await unlink(absPath);
    }
    if (!globalOpts.quiet) {
      if (globalOpts.json) {
        console.log(formatJsonMessage(`Deleted local file: ${relPath}`));
      } else {
        console.log(`Deleted local file: ${relPath}`);
      }
    }
    return;
  }

  if (!existsSync(refPath)) {
    throw new ValidationError(`Not tracked: ${relPath} (no .bref file found)`);
  }

  // Move .bref to trash
  const trashDir = join(repoRoot, '.blobsy', 'trash');
  await ensureDir(trashDir);
  const trashPath = join(trashDir, `${basename(refPath)}.${Date.now()}`);
  await rename(refPath, trashPath);

  // Delete from backend if --remote flag set
  if (deleteRemote) {
    const bref = await readBref(trashPath); // Read from trash copy

    if (bref.remote_key) {
      // Confirmation prompt (unless --force)
      if (!force && !globalOpts.quiet) {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await rl.question(
          `Delete blob from backend?\n` +
            `  File: ${relPath}\n` +
            `  Remote key: ${bref.remote_key}\n` +
            `  This cannot be undone. Continue? (y/N): `,
        );

        rl.close();

        if (answer.toLowerCase() !== 'y') {
          if (!globalOpts.quiet) {
            console.log(
              'Remote deletion cancelled. Local file and .bref removed, remote blob kept.',
            );
          }
          // Still continue with local cleanup below
          deleteRemote = false; // Skip backend deletion
        }
      }

      // Delete from backend if confirmed or --force
      if (deleteRemote) {
        try {
          const config = await resolveConfig(repoRoot, repoRoot);
          const { createBackend, resolveBackend } = await import('./transfer.js');
          if (!config.backends) {
            throw new ValidationError('No backend configured');
          }
          const resolvedBackend = resolveBackend(config);
          const backend = createBackend(resolvedBackend, repoRoot, config.sync?.tools);
          await backend.delete(bref.remote_key);

          if (!globalOpts.quiet) {
            if (globalOpts.json) {
              console.log(formatJsonMessage(`Deleted from backend: ${bref.remote_key}`));
            } else {
              console.log(`Deleted from backend: ${bref.remote_key}`);
            }
          }
        } catch (err: unknown) {
          // Don't fail the whole rm operation if backend deletion fails
          // Local cleanup already succeeded
          console.warn(
            `Warning: Failed to delete from backend: ${(err as Error).message}\n` +
              `  Remote blob may still exist: ${bref.remote_key}`,
          );
        }
      }
    } else if (!globalOpts.quiet) {
      console.log(`Note: File was never pushed (no remote_key), skipping backend deletion`);
    }
  }

  // Remove from gitignore
  await removeGitignoreEntry(fileDir, fileName);

  // Delete local file
  if (existsSync(absPath)) {
    await unlink(absPath);
  }

  // Clean stat cache
  const cacheDir = getStatCacheDir(repoRoot);
  const { deleteCacheEntry } = await import('./stat-cache.js');
  await deleteCacheEntry(cacheDir, relPath);

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Removed ${relPath}`));
    } else {
      console.log(`Removed ${relPath}`);
      console.log(`Moved ${toRepoRelative(refPath, repoRoot)} to trash`);
      console.log(`Deleted local file`);
    }
  }
}

async function handleMv(
  source: string,
  dest: string,
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const repoRoot = findRepoRoot();

  const srcAbs = resolveFilePath(stripBrefExtension(source));
  const destAbs = resolveFilePath(stripBrefExtension(dest));

  if (isDirectory(srcAbs)) {
    await handleMvDirectory(srcAbs, destAbs, repoRoot, globalOpts);
    return;
  }

  const srcRel = toRepoRelative(srcAbs, repoRoot);

  const srcRefPath = brefPath(srcAbs);
  if (!existsSync(srcRefPath)) {
    throw new ValidationError(`Not tracked: ${srcRel} (no .bref file found)`);
  }

  await mvSingleFile(srcAbs, destAbs, repoRoot, globalOpts);
}

async function handleMvDirectory(
  srcDir: string,
  destDir: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
): Promise<void> {
  const brefFiles = findBrefFiles(srcDir, repoRoot);
  if (brefFiles.length === 0) {
    throw new ValidationError(`No tracked files in ${toRepoRelative(srcDir, repoRoot)}`);
  }

  if (globalOpts.dryRun) {
    const actions = brefFiles.map((rel) => {
      const filePath = rel.replace(/\.bref$/, '');
      const relFromSrc = relative(toRepoRelative(srcDir, repoRoot), filePath);
      const destPath = join(toRepoRelative(destDir, repoRoot), relFromSrc);
      return `move ${filePath} -> ${destPath}`;
    });
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const action of actions) {
        console.log(formatDryRun(action));
      }
    }
    return;
  }

  for (const relBref of brefFiles) {
    const filePath = relBref.replace(/\.bref$/, '');
    const srcFileAbs = join(repoRoot, filePath);
    const relFromSrc = relative(toRepoRelative(srcDir, repoRoot), filePath);
    const destFileAbs = join(destDir, relFromSrc);

    await mvSingleFile(srcFileAbs, destFileAbs, repoRoot, globalOpts);
  }
}

async function mvSingleFile(
  srcAbs: string,
  destAbs: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
): Promise<void> {
  const srcRel = toRepoRelative(srcAbs, repoRoot);
  const destRel = toRepoRelative(destAbs, repoRoot);

  const srcRefPath = brefPath(srcAbs);
  const destRefPath = brefPath(destAbs);

  if (globalOpts.dryRun) {
    if (globalOpts.json) {
      console.log(formatJsonDryRun([`move ${srcRel} -> ${destRel}`]));
    } else {
      console.log(formatDryRun(`move ${srcRel} -> ${destRel}`));
    }
    return;
  }

  const ref = await readBref(srcRefPath);

  if (existsSync(srcAbs)) {
    await ensureDir(dirname(destAbs));
    await rename(srcAbs, destAbs);
  }

  await ensureDir(dirname(destRefPath));
  await writeBref(destRefPath, ref);
  await unlink(srcRefPath);

  await removeGitignoreEntry(dirname(srcAbs), basename(srcAbs));
  await addGitignoreEntry(dirname(destAbs), basename(destAbs));

  const cacheDir = getStatCacheDir(repoRoot);
  const { deleteCacheEntry } = await import('./stat-cache.js');
  await deleteCacheEntry(cacheDir, srcRel);
  if (existsSync(destAbs)) {
    const entry = await createCacheEntry(destAbs, destRel, ref.hash);
    await writeCacheEntry(cacheDir, entry);
  }

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Moved ${srcRel} -> ${destRel}`));
    } else {
      console.log(`Moved ${srcRel} -> ${destRel}`);
    }
  }
}

async function handleConfig(
  key: string | undefined,
  value: string | undefined,
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const useGlobal = opts.global === true;
  const showOrigin = opts.showOrigin === true;
  const unset = opts.unset === true;

  // Determine config file path
  let configPath: string;
  let repoRoot: string | undefined;

  if (useGlobal) {
    // Global config works outside git repo
    configPath = getGlobalConfigPath();
  } else {
    // Repo config requires git repo
    repoRoot = findRepoRoot();
    configPath = getConfigPath(repoRoot);
  }

  // Handle --show-origin
  if (showOrigin) {
    if (useGlobal) {
      throw new ValidationError(
        '--show-origin requires a git repository (incompatible with --global)',
      );
    }
    if (!repoRoot) {
      throw new ValidationError('--show-origin requires a git repository');
    }

    const origins = await resolveConfigWithOrigins(repoRoot, repoRoot);

    if (!key) {
      // List all config values with origins
      if (globalOpts.json) {
        const result = Array.from(origins.entries()).map(([k, v]) => ({
          key: k,
          value: v.value,
          origin: v.origin,
          file: v.file ? formatConfigPath(v.file, repoRoot) : undefined,
        }));
        console.log(formatJson({ config: result }));
      } else {
        // Tab-separated output: origin\t[file]\tkey=value
        const sortedKeys = Array.from(origins.keys()).sort();
        for (const k of sortedKeys) {
          const { value: val, origin, file } = origins.get(k)!;
          const fileDisplay = file ? `\t${formatConfigPath(file, repoRoot)}` : '';
          const valueDisplay =
            typeof val === 'object' && val !== null
              ? JSON.stringify(val)
              : `${val as string | number | boolean}`;
          console.log(`${origin}${fileDisplay}\t${k}=${valueDisplay}`);
        }
      }
    } else {
      // Show origin for specific key
      const originInfo = origins.get(key);
      if (globalOpts.json) {
        if (originInfo) {
          console.log(
            formatJson({
              key,
              value: originInfo.value,
              origin: originInfo.origin,
              file: originInfo.file ? formatConfigPath(originInfo.file, repoRoot) : undefined,
            }),
          );
        } else {
          console.log(formatJson({ key, value: undefined, origin: null }));
        }
      } else {
        if (originInfo) {
          const fileDisplay = originInfo.file ? formatConfigPath(originInfo.file, repoRoot) : '';
          const valueDisplay =
            typeof originInfo.value === 'object' && originInfo.value !== null
              ? JSON.stringify(originInfo.value)
              : `${originInfo.value as string | number | boolean}`;
          console.log(`${originInfo.origin}\t${fileDisplay}\t${valueDisplay}`);
        } else {
          console.log('(not set)');
        }
      }
    }
    return;
  }

  // Handle --unset
  if (unset) {
    if (!key) {
      throw new ValidationError('--unset requires a config key');
    }
    if (value) {
      throw new ValidationError('--unset cannot be used with a value argument');
    }

    if (!existsSync(configPath)) {
      if (useGlobal) {
        // Global config doesn't exist, nothing to unset
        if (!globalOpts.quiet) {
          if (globalOpts.json) {
            console.log(formatJsonMessage(`Global config does not exist, nothing to unset`));
          } else {
            console.log('Global config does not exist, nothing to unset');
          }
        }
        return;
      } else {
        throw new ValidationError('No .blobsy.yml found. Run: blobsy setup --auto <url>');
      }
    }

    if (globalOpts.dryRun) {
      if (globalOpts.json) {
        console.log(formatJsonDryRun([`unset ${key}`]));
      } else {
        console.log(formatDryRun(`unset ${key}`));
      }
      return;
    }

    const { parse: parseYaml } = await import('yaml');
    const content = await readFile(configPath, 'utf-8');
    const config = (parseYaml(content) as Record<string, unknown>) ?? {};

    const removed = unsetNestedValue(config, key);

    await writeConfigFile(configPath, config);

    if (!globalOpts.quiet) {
      if (globalOpts.json) {
        const msg = removed ? `Unset ${key}` : `Key ${key} was not set`;
        console.log(formatJsonMessage(msg));
      } else {
        if (removed) {
          console.log(`Unset ${key}`);
          // Show effective value after unset (may fall back to other scope)
          if (!useGlobal && repoRoot) {
            const resolvedConfig = await resolveConfig(repoRoot, repoRoot);
            const effectiveValue = getNestedValue(resolvedConfig, key);
            if (effectiveValue !== undefined) {
              const displayValue =
                typeof effectiveValue === 'object' && effectiveValue !== null
                  ? JSON.stringify(effectiveValue)
                  : `${effectiveValue as string | number | boolean}`;
              console.log(`Effective value (from other scope): ${displayValue}`);
            }
          }
        } else {
          console.log(`Key ${key} was not set`);
        }
      }
    }
    return;
  }

  // Handle normal get/set operations
  if (!key) {
    // Show all config
    if (!existsSync(configPath)) {
      if (globalOpts.json) {
        console.log(formatJson({ config: {} }));
      } else {
        if (useGlobal) {
          console.log('No global .blobsy.yml found.');
        } else {
          console.log('No .blobsy.yml found. Run: blobsy setup --auto <url>');
        }
      }
      return;
    }

    const content = await readFile(configPath, 'utf-8');
    if (globalOpts.json) {
      if (useGlobal) {
        const { parse: parseYaml } = await import('yaml');
        const config = parseYaml(content) as Record<string, unknown>;
        console.log(formatJson({ config }));
      } else if (repoRoot) {
        const config = await resolveConfig(repoRoot, repoRoot);
        console.log(formatJson({ config: config as unknown as Record<string, unknown> }));
      }
    } else {
      console.log(content.trimEnd());
    }
    return;
  }

  if (!value) {
    // Get a specific key
    let val: unknown;
    if (useGlobal) {
      if (!existsSync(configPath)) {
        val = undefined;
      } else {
        const { parse: parseYaml } = await import('yaml');
        const content = await readFile(configPath, 'utf-8');
        const config = parseYaml(content) as Record<string, unknown>;
        val = getNestedValue(config, key);
      }
    } else if (repoRoot) {
      const config = await resolveConfig(repoRoot, repoRoot);
      val = getNestedValue(config, key);
    }

    if (globalOpts.json) {
      console.log(formatJson({ key, value: val }));
    } else {
      if (val === undefined) {
        console.log(`(not set)`);
      } else if (typeof val === 'object') {
        const { stringify } = await import('yaml');
        console.log(stringify(val).trimEnd());
      } else {
        console.log(`${val as string | number | boolean}`);
      }
    }
    return;
  }

  // Set a value
  if (!existsSync(configPath)) {
    if (useGlobal) {
      // Create global config if it doesn't exist
      await writeConfigFile(configPath, {});
    } else {
      throw new ValidationError('No .blobsy.yml found. Run: blobsy setup --auto <url>');
    }
  }

  if (globalOpts.dryRun) {
    if (globalOpts.json) {
      console.log(formatJsonDryRun([`set ${key} = ${value}`]));
    } else {
      console.log(formatDryRun(`set ${key} = ${value}`));
    }
    return;
  }

  const { parse: parseYaml } = await import('yaml');
  const content = await readFile(configPath, 'utf-8');
  const config = (parseYaml(content) as Record<string, unknown>) ?? {};
  setNestedValue(config, key, value);
  await writeConfigFile(configPath, config);

  if (!globalOpts.quiet) {
    if (globalOpts.json) {
      console.log(formatJsonMessage(`Set ${key} = ${value}`));
    } else {
      console.log(`Set ${key} = ${value}`);
    }
  }
}

/**
 * Format a file path for display: use ~ for home directory and relative paths for repo files.
 */
function formatConfigPath(filePath: string, repoRoot?: string): string {
  // Check BLOBSY_HOME first (for testing)
  const blobsyHome = process.env.BLOBSY_HOME;
  if (blobsyHome) {
    const resolvedBlobsyHome = resolve(blobsyHome);
    const resolvedFilePath = resolve(filePath);
    if (resolvedFilePath.startsWith(resolvedBlobsyHome)) {
      return resolvedFilePath.replace(resolvedBlobsyHome, '~');
    }
  }

  // Check actual home directory
  const home = homedir();
  if (filePath.startsWith(home)) {
    return filePath.replace(home, '~');
  }

  // Check repo root for relative paths
  if (repoRoot && filePath.startsWith(repoRoot)) {
    return relative(repoRoot, filePath) || '.';
  }

  return filePath;
}

function getNestedValue(obj: object, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function coerceConfigValue(value: string): string | number | boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim().length > 0) {
    return num;
  }
  return value;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = coerceConfigValue(value);
}

// --- Main ---

export async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof BlobsyError) {
    console.error(formatError(err));
    process.exitCode = err.exitCode;
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
});

#!/usr/bin/env node

/**
 * CLI entry point for blobsy.
 *
 * Commander.js-based CLI with all subcommands, global flags, and
 * dual-mode output (human-readable + JSON).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  c,
  formatCount,
  formatDryRun,
  formatError,
  formatFileState,
  initColors,
  formatJson,
  formatJsonDryRun,
  formatJsonError,
  formatJsonMessage,
  formatSize,
  OUTPUT_SYMBOLS,
} from './format.js';
import { ensureDir } from './fs-utils.js';
import {
  addGitignoreEntry,
  removeGitignoreEntry,
  detectGitignoreConflicts,
  fixGitignoreForBlobsy,
} from './gitignore.js';
import { computeHash } from './hash.js';
import {
  findRepoRoot,
  findBrefFiles,
  findTrackableFiles,
  isDirectory,
  normalizePath,
  resolveRepoPath,
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
  computeFileStates,
} from './commands-stage2.js';
import {
  createCacheEntry,
  deleteCacheEntry,
  getStatCacheDir,
  writeCacheEntry,
} from './stat-cache.js';
import { createBackend, resolveBackend } from './transfer.js';
import { parse as parseYamlDoc, stringify as stringifyYamlDoc } from 'yaml';
import { SKILL_TEXT } from './skill-text.js';
import type { BlobsyConfig, FileStateSymbol, GlobalOptions, Bref } from './types.js';
import { BlobsyError, BREF_FORMAT, ValidationError, UserError } from './types.js';
import { HOOK_TYPES, hooksDisabledByEnv, installHook, wouldInstallHook } from './hooks.js';

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
    .addOption(
      new Option('--color <when>', 'Color output: always, never, auto')
        .choices(['always', 'never', 'auto'])
        .default('auto')
        .hideHelp(false),
    )
    .configureHelp({
      helpWidth: Math.min(88, process.stdout.columns ?? 80),
      showGlobalOptions: true,
      styleTitle: (str: string) => colors.bold(colors.cyan(str)),
      styleCommandText: (str: string) => colors.green(str),
      styleOptionText: (str: string) => colors.yellow(str),
    })
    .showHelpAfterError('(use --help for usage, or blobsy docs for full guide)')
    .hook('preAction', (thisCommand) => {
      const colorMode = thisCommand.opts().color as 'always' | 'never' | 'auto' | undefined;
      if (colorMode) {
        initColors(colorMode);
      }
    });

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
    .command('init', { hidden: true })
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
    .option(
      '--min-size <size>',
      'Override minimum file size for directory tracking (e.g. "100kb", "5mb")',
    )
    .action(wrapAction(handleAdd));

  program
    .command('track', { hidden: true })
    .description('Start tracking files or directories with .bref pointers')
    .argument('<path...>', 'Files or directories to track')
    .option(
      '--min-size <size>',
      'Override minimum file size for directory tracking (e.g. "100kb", "5mb")',
    )
    .action(wrapAction(handleTrack));

  program
    .command('untrack')
    .description('Stop tracking files (keeps local files, moves .bref to trash)')
    .argument('[path...]', 'Files or directories to untrack')
    .option('--all', 'Untrack all tracked files in the repository')
    .option('--recursive', 'Required for directory removal')
    .action(wrapAction(handleUntrack));

  program
    .command('rm')
    .description('Remove tracked files: delete local + move .bref to trash')
    .argument('<path...>', 'Files or directories to remove')
    .option('--local', 'Delete local file only, keep .bref and remote')
    .option(
      '--remote',
      'DANGER: also delete the blob from the backend (breaks git history; requires --force)',
    )
    .option('--force', 'Skip confirmation prompts')
    .option('--recursive', 'Required for directory removal')
    .action(wrapAction(handleRm));

  program
    .command('mv')
    .description('Rename or move tracked files or directories (updates .bref + .gitignore)')
    .argument('<source>', 'Source tracked file or directory')
    .argument('<dest>', 'Destination path')
    .option('--force', 'Overwrite an existing destination file or tracking metadata')
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
    .action(wrapAction(handleSync));

  program
    .command('status')
    .description('Show sync state of tracked files')
    .argument('[path...]', 'Files or directories (default: all tracked)')
    .action(wrapAction(handleStatus));

  program
    .command('verify')
    .description('Verify local files match their .bref hashes')
    .argument('[path...]', 'Files or directories (default: all tracked)')
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
    .command('health', { hidden: true })
    .description('Test backend connectivity and permissions')
    .action(wrapAction(handleHealth));

  program
    .command('doctor')
    .description('Run diagnostics and optionally auto-fix issues')
    .option('--fix', 'Attempt to automatically fix detected issues')
    .action(wrapAction(handleDoctor));

  program
    .command('hooks')
    .description('Install or uninstall blobsy git hooks (pre-commit, pre-push)')
    .argument('<action>', 'install or uninstall')
    .action(wrapAction(handleHooks));

  program
    .command('check-unpushed', { hidden: true })
    .description('List committed .bref files whose blobs are not yet pushed')
    .action(wrapAction(handleCheckUnpushed));

  program
    .command('pre-push-check', { hidden: true })
    .description('CI guard: fail if any .bref is missing its remote blob')
    .action(wrapAction(handlePrePushCheck));

  program
    .command('hook', { hidden: true })
    .description('Internal hook commands')
    .argument('<type>', 'Hook type (pre-commit, pre-push)')
    .action(wrapAction(handleHook));

  program
    .command('readme', { hidden: true })
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
    .option('--readme', 'Display the blobsy README')
    .option('--skill', 'Output blobsy skill documentation (for AI agents)')
    .action(
      wrapAction(async (topic: string | undefined, opts: Record<string, unknown>) => {
        const interactive = isInteractive(opts);

        // CLI-07: readme and skill fold into docs; the standalone commands
        // remain as hidden aliases.
        if (opts.readme) {
          const readme = await loadBundledDoc('README.md');
          const rendered = renderMarkdown(readme, interactive);
          await paginateOutput(rendered, interactive);
          return;
        }
        if (opts.skill) {
          console.log(SKILL_TEXT);
          return;
        }

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
    .command('skill', { hidden: true })
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

declare const __BLOBSY_VERSION__: string;

function getVersion(): string {
  // Build-time injected version (production builds)
  if (typeof __BLOBSY_VERSION__ !== 'undefined') {
    return __BLOBSY_VERSION__;
  }
  // Env var fallback (dev mode via pnpm blobsy)
  if (process.env.BLOBSY_DEV_VERSION) {
    return process.env.BLOBSY_DEV_VERSION;
  }
  // Last resort
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

  // Show next steps (unless quiet/json/dry-run)
  if (!globalOpts.quiet && !globalOpts.json && !globalOpts.dryRun) {
    console.log('');
    console.log(c.success('Setup complete!') + ' Next steps:');
    console.log(c.hint('  blobsy track <file>    Track files with .bref pointers'));
    console.log(c.hint('  blobsy push            Upload to backend'));
    console.log(c.hint('  blobsy status          Check sync state'));
    console.log(c.hint('  blobsy skill           Quick reference for AI agents'));
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

  if (globalOpts.dryRun) {
    const actions = [];
    if (!existsSync(configPath)) {
      actions.push(`create ${normalizePath(toRepoRelative(configPath, repoRoot))}`);
    }
    // Mirror the real path's hook opt-outs (--no-hooks, BLOBSY_NO_HOOKS,
    // hook managers) and per-hook ownership checks — the installer skips
    // existing hooks it doesn't manage — so the plan matches what would
    // actually run (Bugbot r8/r11).
    const hooksEnabled =
      opts.hooks !== false &&
      !hooksDisabledByEnv() &&
      !existsSync(join(repoRoot, 'lefthook.yml')) &&
      !existsSync(join(repoRoot, '.husky'));
    if (hooksEnabled) {
      const plannedHooks: string[] = [];
      for (const hook of HOOK_TYPES) {
        if (await wouldInstallHook(repoRoot, hook)) {
          plannedHooks.push(hook.name);
        }
      }
      if (plannedHooks.length > 0) {
        actions.push(
          `install ${plannedHooks.join(' and ')} hook${plannedHooks.length > 1 ? 's' : ''}`,
        );
      }
    }
    if (globalOpts.json) {
      console.log(formatJsonDryRun(actions));
    } else {
      for (const a of actions) {
        console.log(formatDryRun(a));
      }
    }
    return;
  }

  // Auto-create local backend directory if it doesn't exist
  if (parsed.type === 'local' && parsed.path) {
    const absPath = resolveLocalPath(parsed.path, repoRoot);

    if (!existsSync(absPath)) {
      try {
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

  // Install git hooks (pre-commit and pre-push). Commander maps --no-hooks
  // to opts.hooks === false (NOT opts.noHooks — that key never exists, so
  // checking it made the flag a no-op; review finding CLI-01).
  if (opts.hooks !== false) {
    await installHooks(repoRoot, globalOpts);
  }
}

async function installHooks(repoRoot: string, globalOpts: GlobalOptions): Promise<void> {
  if (hooksDisabledByEnv()) return;

  // Check for hook managers
  if (existsSync(join(repoRoot, 'lefthook.yml')) || existsSync(join(repoRoot, '.husky'))) {
    if (!globalOpts.quiet && !globalOpts.json) {
      console.log('Hook manager detected. Add blobsy hooks to your hook configuration:');
      console.log('  pre-commit: blobsy hook pre-commit');
      console.log('  pre-push:   blobsy hook pre-push');
    }
    return;
  }

  for (const hook of HOOK_TYPES) {
    // Shared installer (review finding HK-02): marker-based ownership
    // check (HK-03) and worktree-safe hooks dir (HK-04).
    const installed = await installHook(repoRoot, hook);

    if (!globalOpts.quiet && !globalOpts.json) {
      if (installed) {
        console.log(`Installed ${hook.name} hook.`);
      } else {
        console.log(
          `Existing ${hook.name} hook found (not managed by blobsy). ` +
            `Add manually: blobsy hook ${hook.gitEvent}`,
        );
      }
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
    const absPath = resolveRepoPath(stripBrefExtension(inputPath), repoRoot);

    if (isDirectory(absPath)) {
      await trackDirectory(absPath, repoRoot, cacheDir, config, globalOpts, minSizeOverride);
    } else {
      await trackSingleFile(absPath, repoRoot, cacheDir, globalOpts);
    }
  }

  // Next-steps guidance
  if (!globalOpts.quiet && !globalOpts.json && !globalOpts.dryRun) {
    console.log('');
    console.log(c.hint('Stage with: blobsy add <path> (or manually: git add *.bref .gitignore)'));
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
    const absPath = resolveRepoPath(stripBrefExtension(inputPath), repoRoot);
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
    // Detect gitignore conflicts before staging
    const conflicts = detectGitignoreConflicts(uniqueFiles, repoRoot);
    if (conflicts.length > 0) {
      // Fix each conflicting gitignore rule
      for (const conflict of conflicts) {
        if (!globalOpts.quiet && !globalOpts.json) {
          console.log(
            `Fixing .gitignore rule: ${conflict.pattern} (in ${toRepoRelative(conflict.gitignorePath, repoRoot)})`,
          );
        }
        await fixGitignoreForBlobsy(conflict.gitignorePath, conflict.lineNumber, conflict.pattern);
      }
      // Re-collect gitignore files that were modified by the fix
      const fixedGitignores = [...new Set(conflicts.map((c) => c.gitignorePath))];
      for (const gi of fixedGitignores) {
        if (!uniqueFiles.includes(gi)) {
          uniqueFiles.push(gi);
        }
      }
    }

    try {
      execFileSync('git', ['add', '--', ...uniqueFiles], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UserError(
        `Failed to stage files to git: ${message}`,
        'Check if the files are inside a gitignored directory.\n  Run `git status` to see the current state.',
        1,
      );
    }

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
          console.log(c.muted(`${relPath} already tracked (unchanged)`));
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
  const onSymlink = globalOpts.verbose
    ? (path: string) => {
        console.error(`Skipping symlink: ${toRepoRelative(path, repoRoot)}`);
      }
    : undefined;
  const files = findTrackableFiles(absDir, config.ignore, onSymlink);
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
      console.log(formatDryRun(`track ${formatCount(trackable.length, 'file')} in ${relDir}/`));
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

      // Hash changed: clear remote_key and compression fields, same as the
      // single-file path — the old key points to the old content, and keeping
      // it would make push report "already pushed" for content the remote
      // does not have (Bugbot round 11).
      const newRef: Bref = {
        ...existingRef,
        hash,
        size: fileSize,
        remote_key: undefined,
        compressed: undefined,
        compressed_size: undefined,
      };
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
      parts.push(`${formatCount(result.externalized, 'file')} tracked`);
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
  const useJson = globalOpts.json;
  const repoRoot = findRepoRoot();

  const files = resolveTrackedFiles(paths, repoRoot);

  if (files.length === 0) {
    if (useJson) {
      console.log(formatJson({ files: [], summary: { total: 0 } }));
    } else {
      console.log(c.muted('No tracked files found.'));
    }
    return;
  }

  const results = await computeFileStates(files);

  // Compute per-state counts
  const stateCounts: Record<string, number> = {};
  for (const r of results) {
    stateCounts[r.state] = (stateCounts[r.state] ?? 0) + 1;
  }

  if (useJson) {
    console.log(
      formatJson({
        files: results.map((r) => ({
          path: r.path,
          state: r.state,
          details: r.details,
          ...(r.size != null ? { size: r.size } : {}),
        })),
        summary: {
          total: results.length,
          ...Object.fromEntries(Object.entries(stateCounts).filter(([, v]) => v > 0)),
        },
      }),
    );
  } else {
    for (const r of results) {
      console.log(formatFileState(r.symbol as FileStateSymbol, r.path, r.details, r.size));
    }
    console.log('');
    const stateParts = Object.entries(stateCounts)
      .filter(([, v]) => v > 0)
      .map(([state, count]) => `${count} ${state}`);
    console.log(`${formatCount(results.length, 'tracked file')}: ${stateParts.join(', ')}`);
  }
}

async function handleVerify(
  paths: string[],
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const useJson = globalOpts.json;
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
      console.log(
        `  ${r.status === 'ok' ? OUTPUT_SYMBOLS.pass : OUTPUT_SYMBOLS.fail}  ${r.path}  ${statusStr}`,
      );
    }
    if (hasIssues) {
      console.log('');
      console.log(c.error('Verification failed.'));
    } else {
      console.log('');
      console.log(c.success('All files verified.'));
    }
  }

  if (hasIssues) {
    process.exitCode = 1;
  }
}

async function handleUntrack(
  paths: string[] | undefined,
  opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = getGlobalOpts(cmd);
  const recursive = Boolean(opts.recursive);
  const untrackAll = Boolean(opts.all);
  const repoRoot = findRepoRoot();
  const inputPaths = paths ?? [];

  if (untrackAll && recursive) {
    throw new ValidationError('Cannot use --all with --recursive');
  }
  if (untrackAll && inputPaths.length > 0) {
    throw new ValidationError('Cannot use --all with explicit paths');
  }
  if (!untrackAll && inputPaths.length === 0) {
    throw new ValidationError('Specify at least one path, or use --all to untrack all files');
  }

  const filesToUntrack: string[] = [];

  if (untrackAll) {
    const allBrefFiles = findBrefFiles(repoRoot, repoRoot);
    if (allBrefFiles.length === 0) {
      const noFilesMsg = 'No tracked files found in repository.';
      if (!globalOpts.quiet) {
        if (globalOpts.json) {
          console.log(formatJsonMessage(noFilesMsg));
        } else {
          console.log(c.muted(noFilesMsg));
        }
      }
      return;
    }
    for (const relPath of allBrefFiles) {
      filesToUntrack.push(join(repoRoot, relPath));
    }
  } else {
    for (const inputPath of inputPaths) {
      const absPath = resolveRepoPath(stripBrefExtension(inputPath), repoRoot);

      if (isDirectory(absPath)) {
        if (!recursive) {
          throw new ValidationError(
            `${toRepoRelative(absPath, repoRoot)} is a directory. Use --recursive to untrack all files in it.`,
          );
        }
        const brefFiles = findBrefFiles(absPath, repoRoot);
        for (const rel of brefFiles) {
          filesToUntrack.push(join(repoRoot, rel));
        }
      } else {
        filesToUntrack.push(absPath);
      }
    }
  }

  for (const absPath of filesToUntrack) {
    await untrackFile(absPath, repoRoot, globalOpts);
  }

  if (untrackAll && !globalOpts.quiet && !globalOpts.json) {
    console.log(`Untracked ${formatCount(filesToUntrack.length, 'file')} across repository`);
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

  await moveBrefToTrash(repoRoot, refPath);

  // Remove from gitignore
  await removeGitignoreEntry(fileDir, fileName);

  // Clean stat cache
  const cacheDir = getStatCacheDir(repoRoot);
  await deleteCacheEntry(cacheDir, relPath);

  // Stage the modified .gitignore
  const gitignorePath = join(fileDir, '.gitignore');
  try {
    execFileSync('git', ['add', '--', gitignorePath], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // Non-fatal: gitignore may be in gitignored directory
  }

  // git rm the old .bref if it was in the index
  try {
    execFileSync('git', ['rm', '--cached', '--', refPath], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // Not in index — that's fine
  }

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

  // Refuse remote deletion up front, before any local mutation, so a refusal
  // never leaves the repo half-cleaned (review finding DS-04). Remote
  // deletion is history-breaking: a .bref is a durable pointer in git
  // history, and deleting the object can break older commits, tags, other
  // branches, other clones sharing the backend, or another .bref sharing a
  // CAS key. No prompt can make that safe (and the design forbids prompts);
  // reachability-aware cleanup is the deferred GC's job. This flag stays
  // only as emergency plumbing: explicit --force, never influenced by
  // --quiet.
  if (deleteRemote && !force) {
    throw new ValidationError(
      'rm --remote permanently deletes the blob for ALL git history — older ' +
        'commits, tags, and other clones that reference it will break. ' +
        'If you are sure, re-run with --force. ' +
        'To stop tracking without destroying history, use rm without --remote.',
    );
  }

  for (const inputPath of paths) {
    const absPath = resolveRepoPath(stripBrefExtension(inputPath), repoRoot);

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

  // Every rm variant requires the file to be tracked BEFORE touching the
  // payload — `rm --local somefile` used to unlink untracked files, which
  // is unrecoverable since blobsy holds no copy (review finding CLI-05).
  if (!existsSync(refPath)) {
    throw new ValidationError(`Not tracked: ${relPath} (no .bref file found)`);
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

  const trashPath = await moveBrefToTrash(repoRoot, refPath);

  // Delete from backend if --remote --force (handleRm refuses --remote
  // without --force before any local mutation; see the DS-04 rationale
  // there). No prompt: prompts are forbidden by design, and --quiet must
  // never influence a safety decision.
  if (deleteRemote) {
    const bref = await readBref(trashPath); // Read from trash copy

    if (bref.remote_key) {
      try {
        const config = await resolveConfig(repoRoot, repoRoot);
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
        // Local cleanup already succeeded and the remaining steps below must
        // still run, but the destructive half of `rm --remote --force` did
        // NOT happen — automation must see a failure exit, not a warning
        // that scrolls past while the command reports success (Bugbot r12).
        const error = err instanceof Error ? err : new Error(String(err));
        if (globalOpts.json) {
          console.error(formatJsonError(error));
        } else {
          console.error(
            `Error: Failed to delete from backend: ${error.message}\n` +
              `  Remote blob still exists: ${bref.remote_key}\n` +
              `  Local tracking was removed; delete the remote object manually if needed.`,
          );
        }
        process.exitCode = 1;
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
  await deleteCacheEntry(cacheDir, relPath);

  // Stage the modified .gitignore
  const gitignorePath = join(fileDir, '.gitignore');
  try {
    execFileSync('git', ['add', '--', gitignorePath], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // Non-fatal: gitignore may be in gitignored directory
  }

  // git rm the old .bref if it was in the index
  try {
    execFileSync('git', ['rm', '--cached', '--', refPath], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // Not in index — that's fine
  }

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

  const srcAbs = resolveRepoPath(stripBrefExtension(source), repoRoot);
  const destAbs = resolveRepoPath(stripBrefExtension(dest), repoRoot);

  const force = Boolean(opts.force);

  if (isDirectory(srcAbs)) {
    await handleMvDirectory(srcAbs, destAbs, repoRoot, globalOpts, force);
    return;
  }

  const srcRel = toRepoRelative(srcAbs, repoRoot);

  const srcRefPath = brefPath(srcAbs);
  if (!existsSync(srcRefPath)) {
    throw new ValidationError(`Not tracked: ${srcRel} (no .bref file found)`);
  }

  await mvSingleFile(srcAbs, destAbs, repoRoot, globalOpts, force);
}

async function handleMvDirectory(
  srcDir: string,
  destDir: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
  force: boolean,
): Promise<void> {
  const brefFiles = findBrefFiles(srcDir, repoRoot);
  if (brefFiles.length === 0) {
    throw new ValidationError(`No tracked files in ${toRepoRelative(srcDir, repoRoot)}`);
  }

  if (globalOpts.dryRun) {
    // findBrefFiles returns payload-relative paths (no .bref suffix) — L-04.
    const actions = brefFiles.map((relPath) => {
      const relFromSrc = relative(toRepoRelative(srcDir, repoRoot), relPath);
      const destPath = join(toRepoRelative(destDir, repoRoot), relFromSrc);
      return `move ${relPath} -> ${destPath}`;
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

  for (const relPath of brefFiles) {
    const srcFileAbs = join(repoRoot, relPath);
    const relFromSrc = relative(toRepoRelative(srcDir, repoRoot), relPath);
    const destFileAbs = join(destDir, relFromSrc);

    await mvSingleFile(srcFileAbs, destFileAbs, repoRoot, globalOpts, force);
  }
}

async function mvSingleFile(
  srcAbs: string,
  destAbs: string,
  repoRoot: string,
  globalOpts: GlobalOptions,
  force: boolean,
): Promise<void> {
  const srcRel = toRepoRelative(srcAbs, repoRoot);
  const destRel = toRepoRelative(destAbs, repoRoot);

  const srcRefPath = brefPath(srcAbs);
  const destRefPath = brefPath(destAbs);

  // Refuse to clobber an existing destination (review finding CLI-04):
  // overwriting dest.bref silently destroys that file's tracking metadata
  // and leaves a dangling gitignore entry.
  const destBlocked =
    !force && (existsSync(destRefPath) || (existsSync(destAbs) && !isDirectory(destAbs)));

  if (globalOpts.dryRun) {
    const action = destBlocked
      ? `refuse ${srcRel} -> ${destRel} (destination exists; would need --force)`
      : `move ${srcRel} -> ${destRel}`;
    if (globalOpts.json) {
      console.log(formatJsonDryRun([action]));
    } else {
      console.log(formatDryRun(action));
    }
    if (destBlocked) {
      process.exitCode = 1;
    }
    return;
  }

  if (destBlocked) {
    throw new ValidationError(
      `Destination already exists: ${existsSync(destRefPath) ? `${destRel}.bref` : destRel}`,
      ['Use --force to overwrite, or pick a different destination.'],
    );
  }

  const ref = await readBref(srcRefPath);

  if (existsSync(srcAbs)) {
    await ensureDir(dirname(destAbs));
    try {
      await rename(srcAbs, destAbs);
    } catch (err) {
      // rename() cannot cross filesystems; fall back to copy + unlink
      // (review finding CLI-04).
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyFile(srcAbs, destAbs);
        await unlink(srcAbs);
      } else {
        throw err;
      }
    }
  }

  await ensureDir(dirname(destRefPath));
  await writeBref(destRefPath, ref);
  await unlink(srcRefPath);

  await removeGitignoreEntry(dirname(srcAbs), basename(srcAbs));
  await addGitignoreEntry(dirname(destAbs), basename(destAbs));

  const cacheDir = getStatCacheDir(repoRoot);
  await deleteCacheEntry(cacheDir, srcRel);
  if (existsSync(destAbs)) {
    const entry = await createCacheEntry(destAbs, destRel, ref.hash);
    await writeCacheEntry(cacheDir, entry);
  }

  // Stage changes to git
  const filesToStage = [
    destRefPath,
    join(dirname(destAbs), '.gitignore'),
    join(dirname(srcAbs), '.gitignore'),
  ];
  try {
    execFileSync('git', ['add', '--', ...filesToStage], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // Non-fatal: files may be in gitignored directory
  }

  // git rm the old .bref if it was in the index
  try {
    execFileSync('git', ['rm', '--cached', '--', srcRefPath], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch {
    // Not in index — that's fine
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

    const parseYaml = parseYamlDoc;
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
        const parseYaml = parseYamlDoc;
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
        const parseYaml = parseYamlDoc;
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
        const stringify = stringifyYamlDoc;
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

  const parseYaml = parseYamlDoc;
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

/**
 * Reject key segments that traverse into the prototype chain.
 *
 * `blobsy config __proto__.x 1` would otherwise pollute Object.prototype for
 * the running process (review finding SEC-01).
 */
export function assertSafeKeyPath(parts: string[]): void {
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new ValidationError(`Invalid config key segment: ${part}`);
    }
  }
}

function getNestedValue(obj: object, path: string): unknown {
  const parts = path.split('.');
  assertSafeKeyPath(parts);
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Move a `.bref` to `.blobsy/trash/`, preserving its repo-relative path
 * (the design's path-preserving layout — review finding L-01). A numeric
 * suffix avoids overwriting when the same path is trashed repeatedly.
 */
async function moveBrefToTrash(repoRoot: string, refPath: string): Promise<string> {
  const rel = toRepoRelative(refPath, repoRoot);
  const trashRoot = join(repoRoot, '.blobsy', 'trash');
  let trashPath = join(trashRoot, rel);
  await ensureDir(dirname(trashPath));
  for (let n = 1; existsSync(trashPath); n++) {
    trashPath = join(trashRoot, `${rel}.${n}`);
  }
  await rename(refPath, trashPath);
  return trashPath;
}

/**
 * Coerce a `blobsy config` value string to boolean/number where unambiguous.
 * Only plain decimal numbers coerce — `Number()` also accepted hex and
 * `Infinity` (review finding L-03).
 */
function coerceConfigValue(value: string): string | number | boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value.trim()) && value.trim().length > 0) {
    return Number(value);
  }
  return value;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  assertSafeKeyPath(parts);
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

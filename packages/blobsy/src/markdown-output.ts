/**
 * Markdown rendering and pagination for CLI documentation output.
 *
 * TTY: colorized markdown via marked-terminal, paginated with less -R
 * Piped/non-TTY: plain markdown, no ANSI codes, no pagination
 */

import { spawn } from 'node:child_process';

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const MAX_WIDTH = 88;
const PAGINATION_THRESHOLD = 40;

function getTerminalWidth(): number {
  return Math.min(MAX_WIDTH, process.stdout.columns ?? 80);
}

/** True when stdout is a TTY and --json/--quiet are not set. */
export function isInteractive(opts: Record<string, unknown>): boolean {
  return !opts.json && !opts.quiet && process.stdout.isTTY === true;
}

/**
 * Render markdown to colorized terminal output.
 * Returns plain markdown when not interactive.
 */
export function renderMarkdown(content: string, interactive: boolean): string {
  if (!interactive) {
    return content;
  }
  marked.use(
    markedTerminal({
      width: getTerminalWidth(),
      reflowText: true,
    }) as unknown as Parameters<typeof marked.use>[0],
  );
  return marked.parse(content) as string;
}

/**
 * Output content, paginating through less -R if interactive and long.
 * Falls back to console.log if pager is unavailable.
 */
export async function paginateOutput(content: string, interactive: boolean): Promise<void> {
  const lines = content.split('\n').length;

  if (!interactive || lines < PAGINATION_THRESHOLD || !process.stdout.isTTY) {
    console.log(content);
    return;
  }

  const pager = process.env.PAGER ?? 'less -R';
  const [cmd, ...args] = pager.split(' ');

  return new Promise((resolve) => {
    const child = spawn(cmd!, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') {
        return;
      }
    });

    child.stdin.write(content);
    child.stdin.end();

    child.on('close', () => {
      resolve();
    });
    child.on('error', () => {
      console.log(content);
      resolve();
    });
  });
}

export interface DocSection {
  title: string;
  slug: string;
}

/** Extract ## section headers and slugified IDs from markdown. */
export function extractSections(content: string): DocSection[] {
  const sections: DocSection[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim();
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      sections.push({ title, slug });
    }
  }
  return sections;
}

/** Find and extract a section by slug or partial title match. */
export function findSection(content: string, sections: DocSection[], query: string): string | null {
  const lower = query.toLowerCase();
  const match =
    sections.find((s) => s.slug === lower) ??
    sections.find((s) => s.title.toLowerCase().includes(lower));
  if (!match) {
    return null;
  }

  const lines = content.split('\n');
  const result: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (inSection) {
        break;
      }
      if (line.slice(3).trim() === match.title) {
        inSection = true;
        result.push(line);
      }
    } else if (inSection) {
      result.push(line);
    }
  }

  // Trim trailing blank lines
  while (result.length > 0 && result[result.length - 1]?.trim() === '') {
    result.pop();
  }

  return result.length > 0 ? result.join('\n') : null;
}

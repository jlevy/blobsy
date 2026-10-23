import { describe, expect, it } from 'vitest';

import {
  extractSections,
  findSection,
  isInteractive,
  renderMarkdown,
} from '../src/markdown-output.js';

const SAMPLE_DOC = `# Title

Some intro text.

## First Section

First section content.
More lines here.

## Second Section

Second section content.

## S3 (and S3-compatible)

S3 content here.

## Empty Section

`;

describe('extractSections', () => {
  it('extracts ## headers with slugs', () => {
    const sections = extractSections(SAMPLE_DOC);
    expect(sections).toEqual([
      { title: 'First Section', slug: 'first-section' },
      { title: 'Second Section', slug: 'second-section' },
      { title: 'S3 (and S3-compatible)', slug: 's3-and-s3-compatible' },
      { title: 'Empty Section', slug: 'empty-section' },
    ]);
  });

  it('ignores # and ### headers', () => {
    const doc = '# H1\n## H2\n### H3\n## H2b';
    const sections = extractSections(doc);
    expect(sections.map((s) => s.title)).toEqual(['H2', 'H2b']);
  });

  it('handles special characters in titles', () => {
    const doc = '## S3 (and S3-compatible)\n## CI/CD Integration';
    const sections = extractSections(doc);
    expect(sections).toEqual([
      { title: 'S3 (and S3-compatible)', slug: 's3-and-s3-compatible' },
      { title: 'CI/CD Integration', slug: 'ci-cd-integration' },
    ]);
  });
});

describe('findSection', () => {
  const sections = extractSections(SAMPLE_DOC);

  it('exact slug match returns section content', () => {
    const result = findSection(SAMPLE_DOC, sections, 'first-section');
    expect(result).toContain('## First Section');
    expect(result).toContain('First section content.');
    expect(result).not.toContain('## Second Section');
  });

  it('partial title match works', () => {
    const result = findSection(SAMPLE_DOC, sections, 'second');
    expect(result).toContain('## Second Section');
    expect(result).toContain('Second section content.');
  });

  it('returns null for no match', () => {
    const result = findSection(SAMPLE_DOC, sections, 'nonexistent');
    expect(result).toBeNull();
  });

  it('trims trailing blank lines', () => {
    const result = findSection(SAMPLE_DOC, sections, 'second-section');
    expect(result).not.toMatch(/\n\s*$/);
  });
});

describe('renderMarkdown', () => {
  it('returns content unchanged when not interactive', () => {
    const content = '# Hello\n\nSome **bold** text.';
    expect(renderMarkdown(content, false)).toBe(content);
  });
});

describe('isInteractive', () => {
  it('returns false when opts.json is set', () => {
    expect(isInteractive({ json: true })).toBe(false);
  });

  it('returns false when opts.quiet is set', () => {
    expect(isInteractive({ quiet: true })).toBe(false);
  });

  it('returns false when stdout is not a TTY', () => {
    // In test environment, stdout.isTTY is typically undefined
    expect(isInteractive({})).toBe(false);
  });
});

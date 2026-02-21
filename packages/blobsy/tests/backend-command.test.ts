import { describe, expect, it } from 'vitest';

import { parseAndExpandCommand, commandBlobExists } from '../src/backend-command.js';
import type { CommandTemplateVars } from '../src/backend-command.js';

describe('parseAndExpandCommand', () => {
  const vars: CommandTemplateVars = {
    local: '/tmp/file.bin',
    remote: 'mybucket/prefix/key',
    relative_path: 'data/model.bin',
    bucket: 'mybucket',
  };

  it('splits template and expands all variables', () => {
    const template = 'aws s3 cp {local} s3://{remote}';
    expect(parseAndExpandCommand(template, vars)).toEqual([
      'aws',
      's3',
      'cp',
      '/tmp/file.bin',
      's3://mybucket/prefix/key',
    ]);
  });

  it('expands multiple occurrences in one token', () => {
    const template = 'echo {bucket}-{bucket}';
    expect(parseAndExpandCommand(template, vars)).toEqual(['echo', 'mybucket-mybucket']);
  });

  it('rejects unknown template variables', () => {
    const template = '{local} {unknown}';
    expect(() => parseAndExpandCommand(template, vars)).toThrow(
      'Unknown template variable {unknown}',
    );
  });

  it('expands relative_path', () => {
    const template = 'echo {relative_path}';
    expect(parseAndExpandCommand(template, vars)).toEqual(['echo', 'data/model.bin']);
  });

  it('rejects unsafe characters in expanded values', () => {
    const evilVars: CommandTemplateVars = {
      local: "/tmp/file'; rm -rf /",
      remote: 'safe',
      relative_path: 'safe',
      bucket: 'safe',
    };
    expect(() => parseAndExpandCommand('cp {local} dest', evilVars)).toThrow('Unsafe characters');
  });

  it('expands environment variables', () => {
    const original = process.env.BLOBSY_TEST_VAR;
    try {
      process.env.BLOBSY_TEST_VAR = '/usr/local/bin/my-tool';
      expect(parseAndExpandCommand('$BLOBSY_TEST_VAR push {local}', vars)).toEqual([
        '/usr/local/bin/my-tool',
        'push',
        '/tmp/file.bin',
      ]);
    } finally {
      if (original === undefined) {
        delete process.env.BLOBSY_TEST_VAR;
      } else {
        process.env.BLOBSY_TEST_VAR = original;
      }
    }
  });

  it('expands braced environment variables', () => {
    const original = process.env.BLOBSY_TEST_VAR;
    try {
      process.env.BLOBSY_TEST_VAR = '/path/to/tool';
      expect(parseAndExpandCommand('${BLOBSY_TEST_VAR} {local}', vars)).toEqual([
        '/path/to/tool',
        '/tmp/file.bin',
      ]);
    } finally {
      if (original === undefined) {
        delete process.env.BLOBSY_TEST_VAR;
      } else {
        process.env.BLOBSY_TEST_VAR = original;
      }
    }
  });

  it('rejects undefined environment variables', () => {
    delete process.env.BLOBSY_DEFINITELY_NOT_SET_12345;
    expect(() => parseAndExpandCommand('$BLOBSY_DEFINITELY_NOT_SET_12345 {local}', vars)).toThrow(
      'Undefined environment variable',
    );
  });

  it('rejects empty template', () => {
    expect(() => parseAndExpandCommand('', vars)).toThrow('Command template is empty');
  });

  it('allows spaces in expanded values', () => {
    const spaceyVars: CommandTemplateVars = {
      local: '/tmp/path with spaces/file.bin',
      remote: 'mybucket/key',
      relative_path: 'data/model.bin',
      bucket: 'mybucket',
    };
    expect(parseAndExpandCommand('cp {local} {remote}', spaceyVars)).toEqual([
      'cp',
      '/tmp/path with spaces/file.bin',
      'mybucket/key',
    ]);
  });
});

describe('commandBlobExists', () => {
  it('returns true for a command that succeeds', () => {
    expect(
      commandBlobExists('true', {
        local: '',
        remote: '',
        relative_path: '',
        bucket: '',
      }),
    ).toBe(true);
  });

  it('returns false for a command that fails', () => {
    expect(
      commandBlobExists('false', {
        local: '',
        remote: '',
        relative_path: '',
        bucket: '',
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { expandCommandTemplate, commandBlobExists } from '../src/backend-command.js';
import type { CommandTemplateVars } from '../src/backend-command.js';

describe('expandCommandTemplate', () => {
  const vars: CommandTemplateVars = {
    local: '/tmp/file.bin',
    remote: 'mybucket/prefix/key',
    relative_path: 'data/model.bin',
    bucket: 'mybucket',
  };

  it('expands all variables with shell escaping', () => {
    const template = 'aws s3 cp {local} s3://{remote}';
    expect(expandCommandTemplate(template, vars)).toBe(
      "aws s3 cp '/tmp/file.bin' s3://'mybucket/prefix/key'",
    );
  });

  it('expands multiple occurrences', () => {
    const template = '{bucket}-{bucket}';
    expect(expandCommandTemplate(template, vars)).toBe("'mybucket'-'mybucket'");
  });

  it('leaves unknown placeholders', () => {
    const template = '{local} {unknown}';
    expect(expandCommandTemplate(template, vars)).toBe("'/tmp/file.bin' {unknown}");
  });

  it('expands relative_path', () => {
    const template = 'echo {relative_path}';
    expect(expandCommandTemplate(template, vars)).toBe("echo 'data/model.bin'");
  });

  it('escapes single quotes in values', () => {
    const evilVars: CommandTemplateVars = {
      local: "/tmp/file'; rm -rf /; echo '",
      remote: 'safe',
      relative_path: 'safe',
      bucket: 'safe',
    };
    const result = expandCommandTemplate('cp {local} dest', evilVars);
    expect(result).toBe("cp '/tmp/file'\\''; rm -rf /; echo '\\''' dest");
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

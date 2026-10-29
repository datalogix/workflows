import { expect, test } from 'vitest';
import { BOOLEAN, HELP, parseArgs, VALUE } from '../lib/args.js';

test('parses the command and its flags', () => {
  expect(parseArgs([])).toStrictEqual({ command: 'setup', flags: {} });
  expect(parseArgs(['check', '--repo', 'datalogix/app'])).toStrictEqual({
    command: 'check',
    flags: { repo: 'datalogix/app' },
  });
  expect(parseArgs(['--deploy=forge', '--no-staging', '--solo', '--yes']).flags).toStrictEqual({
    deploy: 'forge',
    staging: false,
    solo: true,
    yes: true,
  });
  expect(parseArgs(['--incidents=false']).flags).toStrictEqual({ incidents: false });
  expect(parseArgs(['--solo=yes', '--yes=0']).flags).toStrictEqual({ solo: true, yes: false });
  // Checked by the stack's question (setup), as each stack deploys elsewhere
  expect(parseArgs(['--deploy', 'heroku']).flags).toStrictEqual({ deploy: 'heroku' });
  expect(parseArgs(['--help']).command).toBe('help');
});

test('rejects bad arguments', () => {
  expect(() => parseArgs(['--yes=off'])).toThrow('--yes takes true or false');
  expect(() => parseArgs(['--domain'])).toThrow(/needs a value/);
  expect(() => parseArgs(['setup', 'extra'])).toThrow(/Unexpected argument/);
  expect(() => parseArgs(['--domian', 'app.example.com'])).toThrow(/Unknown option: --domian/);
  expect(() => parseArgs(['--no-deploy'])).toThrow(/Unknown option: --no-deploy/);
  expect(() => parseArgs(['check', '--repo', 'app'])).toThrow(/--repo must be owner\/repo/);
});

test('accepts the stack and an app or package kind', () => {
  expect(parseArgs(['setup', '--stack', 'laravel', '--kind', 'package']).flags).toStrictEqual({
    stack: 'laravel',
    kind: 'package',
  });
  expect(() => parseArgs(['setup', '--kind', 'library'])).toThrow('--kind must be app or package');
  expect(parseArgs(['org', '--org', 'datalogix']).flags).toStrictEqual({ org: 'datalogix' });
  expect(() => parseArgs(['org', '--org', 'datalogix/app'])).toThrow('--org must be an organization name');
});

test('takes a flag that follows a value option as a missing value', () => {
  expect(() => parseArgs(['setup', '--domain', '--yes'])).toThrow('--domain needs a value');
});

test('lists every option it accepts in the help', () => {
  for (const name of [...BOOLEAN, ...VALUE]) expect(HELP, name).toContain(`--${name}`);
});

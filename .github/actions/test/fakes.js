import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const actions = join(import.meta.dirname, '..');

// gh: the first rule whose `match` (a regular expression) matches the arguments answers; --jq is applied with the real jq.
// A rule with `jq` (a string, or a regular expression) also needs that --jq filter. A rule with `responses` answers each
// call with the next one ({ stdout, stderr, code }; the last one repeats), like the codes of curl.
// Calls no rule matched are also listed in unmatched.jsonl, so a test can tell a default answer from a configured one.
const GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const dir = process.env.FAKE_DIR;
let args = process.argv.slice(2);
appendFileSync(dir + '/calls.jsonl', JSON.stringify(['gh', ...args]) + '\\n');
let jq = null;
const at = args.indexOf('--jq');
if (at !== -1) {
  jq = args[at + 1];
  args = [...args.slice(0, at), ...args.slice(at + 2)];
}
const rules = JSON.parse(readFileSync(dir + '/gh.json', 'utf8'));
const filterMatches = (expected) =>
  expected === undefined ||
  (typeof expected === 'string' ? expected === jq : jq !== null && new RegExp(expected.source, expected.flags).test(jq));
const index = rules.findIndex(
  (candidate) => new RegExp(candidate.match).test(args.join(' ')) && filterMatches(candidate.jq),
);
if (index === -1) appendFileSync(dir + '/unmatched.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
let rule = rules[index] ?? {};
if (rule.responses) {
  const seen = JSON.parse(readFileSync(dir + '/gh-seen.json', 'utf8'));
  seen[index] = (seen[index] ?? 0) + 1;
  writeFileSync(dir + '/gh-seen.json', JSON.stringify(seen));
  rule = rule.responses[Math.min(seen[index], rule.responses.length) - 1];
}
if (rule.code) {
  process.stderr.write(rule.stderr ?? 'gh failed');
  process.exit(rule.code);
}
// A notice gh prints on success
if (rule.stderr) process.stderr.write(rule.stderr);
let stdout = typeof rule.stdout === 'string' ? rule.stdout : rule.stdout === undefined ? '' : JSON.stringify(rule.stdout);
if (jq !== null && stdout !== '') stdout = execFileSync('jq', ['-rc', jq], { input: stdout, encoding: 'utf8' });
process.stdout.write(stdout);
`;

// curl: answers each URL with the next HTTP code of its rule (the last one repeats); "000" is a connection failure.
// The content of header files (-H @file) and of the data read from stdin is recorded after the arguments.
const CURL = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const url = args.filter((arg) => /^https?:/.test(arg)).at(-1) ?? '';
const headers = args
  .filter((arg, i) => args[i - 1] === '-H' && arg.startsWith('@'))
  .flatMap((arg) => ['<header>', readFileSync(arg.slice(1), 'utf8')]);
const stdin = args.includes('@-') ? readFileSync(0, 'utf8') : undefined;
appendFileSync(dir + '/calls.jsonl', JSON.stringify(['curl', ...args, ...headers, ...(stdin === undefined ? [] : ['<stdin>', stdin])]) + '\\n');
const rules = JSON.parse(readFileSync(dir + '/curl.json', 'utf8'));
const index = rules.findIndex((candidate) => new RegExp(candidate.match).test(url));
const seen = JSON.parse(readFileSync(dir + '/curl-seen.json', 'utf8'));
seen[index] = (seen[index] ?? 0) + 1;
writeFileSync(dir + '/curl-seen.json', JSON.stringify(seen));
const codes = index === -1 ? ['200'] : rules[index].codes;
const code = String(codes[Math.min(seen[index], codes.length) - 1]);
if (args.includes('-w')) process.stdout.write(code);
process.exit(code === '000' ? 28 : args.includes('--fail') && Number(code) >= 400 ? 22 : 0);
`;

const SLEEP = `#!/usr/bin/env bash
echo "[\\"sleep\\", \\"$1\\"]" >> "$FAKE_DIR/calls.jsonl"
`;

/**
 * Runs a script of an action with fake gh, curl and sleep in PATH, and `event` as the event payload. Returns its exit code and output, the calls
 * made to the fakes (as argument arrays), the gh calls no rule matched, what it wrote to GITHUB_OUTPUT and to the step summary.
 * `setup` prepares the folder before the run (e.g. a git repository) and may return the folder the script runs in.
 */
export async function runScript(script, { args = [], env = {}, event = {}, gh = [], curl = [], setup } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'action-'));
  try {
    for (const [name, content] of [
      ['gh', GH],
      ['curl', CURL],
      ['sleep', SLEEP],
    ]) {
      await writeFile(join(dir, name), content);
      await chmod(join(dir, name), 0o755);
    }
    // A regular expression in `jq` is written as its source and flags
    const ghRules = gh.map((rule) =>
      rule.jq instanceof RegExp ? { ...rule, jq: { source: rule.jq.source, flags: rule.jq.flags } } : rule,
    );
    await writeFile(join(dir, 'gh.json'), JSON.stringify(ghRules));
    await writeFile(join(dir, 'gh-seen.json'), '{}');
    await writeFile(join(dir, 'curl.json'), JSON.stringify(curl));
    await writeFile(join(dir, 'curl-seen.json'), '{}');
    for (const file of ['calls.jsonl', 'unmatched.jsonl', 'output', 'summary']) await writeFile(join(dir, file), '');
    await writeFile(join(dir, 'event.json'), JSON.stringify(event));

    const cwd = (await setup?.(dir)) ?? dir;
    const child = spawn('bash', [join(actions, script), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: dir,
        FAKE_DIR: dir,
        GITHUB_REPOSITORY: 'datalogix/app',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_OUTPUT: join(dir, 'output'),
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GITHUB_EVENT_PATH: join(dir, 'event.json'),
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.on('close', resolve));

    const read = (file) => readFile(join(dir, file), 'utf8');
    const lines = async (file) =>
      (await read(file))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const outputs = Object.fromEntries(
      (await read('output'))
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );

    return {
      code,
      stdout,
      stderr,
      calls: await lines('calls.jsonl'),
      unmatched: await lines('unmatched.jsonl'),
      outputs,
      summary: await read('summary'),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The calls made to one command, as argument strings. */
export function callsTo(result, command) {
  return result.calls.filter(([name]) => name === command).map(([, ...args]) => args.join(' '));
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
const READ_SUBCOMMANDS = new Set(['view', 'list', 'status', 'diff', 'checks']);

/**
 * The gh calls no rule matched that only read: `gh api` without a write method (fields are query parameters when the
 * method is GET; without a method gh posts them) and read subcommands such as `gh pr view`. A read answered by the
 * default empty output usually means a rule is missing.
 */
export function unmatchedReads(result) {
  return result.unmatched.filter(([command, ...args]) => {
    if (command !== 'api') return READ_SUBCOMMANDS.has(args[0]);
    const at = args.findIndex((arg) => arg === '-X' || arg === '--method');
    const method = at === -1 ? undefined : args[at + 1]?.toUpperCase();
    if (method !== undefined) return !WRITE_METHODS.has(method);
    return !args.some((arg) => FIELD_FLAGS.has(arg));
  });
}

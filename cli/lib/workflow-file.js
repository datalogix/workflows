import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRoot } from './project.js';

export const WORKFLOW_PATH = '.github/workflows/datalogix.yml';

const OPTIONAL_MARKER = '    # All inputs are optional:';

// The pipeline job's `with:` line, which may end with a comment
const WITH = /^ {4}with:[ \t]*(?:#.*)?$/;

/** The text with LF line ends: a workflow file written on Windows has CRLF ones. */
export function lf(content) {
  return content.replace(/\r\n?/g, '\n');
}

/**
 * Reads the `with:` block of the pipeline job as { input: raw value }. A multi-line value (`key: |` followed by
 * more indented lines) keeps its lines as they are, so it can be written back unchanged.
 */
export function parseInputs(content) {
  const inputs = {};
  const lines = lf(content).split('\n');
  const block = inputsBlock(lines);
  if (!block) return inputs;
  let current = null;
  let blank = [];
  for (const line of lines.slice(block.start + 1, block.end)) {
    const match = /^ {6}([\w-]+):\s*(.*)$/.exec(line);
    if (match) {
      current = match[1];
      inputs[current] = match[2].trim();
      blank = [];
    } else if (current && /^ {7,}\S/.test(line)) {
      inputs[current] += `\n${[...blank, line.trimEnd()].join('\n')}`;
      blank = [];
    } else if (line.trim() === '') {
      blank.push('');
    } else if (!line.trim().startsWith('#')) {
      break;
    }
  }
  return inputs;
}

/**
 * Where the pipeline job's `with:` block is in the file's lines: the index of `with:` and of the first line after
 * the block (at most the end of the job), or null without one.
 */
function inputsBlock(lines) {
  const job = pipelineEnd(lines);
  const start = lines.slice(0, job).findIndex((line) => WITH.test(line));
  return start === -1 ? null : { start, end: job };
}

/**
 * The index of the first line after the pipeline job (another job, say), or the number of lines. Blank lines and
 * comments less indented than the job's keys right before the next key belong to what follows.
 */
function pipelineEnd(lines) {
  const start = lines.findIndex((line) => /^ {2}pipeline:/.test(line));
  if (start === -1) return lines.length;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^ {4}/.test(lines[end]) || /^\s*#/.test(lines[end]))) {
    end++;
  }
  if (end < lines.length) {
    while (end > start + 1 && (lines[end - 1].trim() === '' || /^ {0,3}#/.test(lines[end - 1]))) end--;
  }
  return end;
}

/** What the file has after the pipeline job (another job, say), without the blank lines around it. */
export function afterInputs(content) {
  const lines = lf(content).split('\n');
  return lines
    .slice(pipelineEnd(lines))
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
}

/** The comment after an input's raw value (`forge # prod` → `# prod`), or null. */
export function inputComment(raw) {
  const line = raw?.split('\n')[0] ?? '';
  // A # inside a quoted value is part of it
  const rest = line.slice(/^(['"]).*?\1/.exec(line)?.[0].length ?? 0);
  return /(?:^|\s)(#.*)$/.exec(rest)?.[1] ?? null;
}

/** The inputs whose comment after the value the rendered workflow file no longer has, e.g. a value setup replaces. */
export function droppedInputComments(content, rendered) {
  const after = parseInputs(rendered);
  return Object.entries(parseInputs(content))
    .filter(([name, raw]) => inputComment(raw) && inputComment(after[name]) !== inputComment(raw))
    .map(([name]) => name);
}

/** Whether the `with:` block of the pipeline job has comment lines, which setup does not write back. */
export function hasInputComments(content) {
  const lines = lf(content).split('\n');
  const block = inputsBlock(lines);
  if (!block) return false;
  if (/#/.test(lines[block.start])) return true;
  for (const line of lines.slice(block.start + 1, block.end)) {
    if (/^\s+#/.test(line)) return true;
    if (line.trim() && !/^ {6}/.test(line)) return false;
  }
  return false;
}

/**
 * Branch patterns whose pushes run the workflow, for runsOnPush: `on.push.branches`, or `branches-ignore` as
 * ['**', '!name'], each as a flow (`[develop, main]`) or block list. Empty when no branch push runs it (no push
 * trigger, or only tags), null when every branch push does (a push trigger without a branch filter, or no `on:` it
 * can read).
 */
export function pushBranches(content) {
  const text = lf(content);
  // Some formatters quote the key: 'on':
  const on = /^(?:on|'on'|"on"):[ \t]*(.*)$/m.exec(text);
  if (!on) return null;
  // on: push, on: [push, pull_request], on: { push: { branches: [main] } }
  const inline = on[1].replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('{')) return inlinePushBranches(inline);
  if (inline) return /\bpush\b/.test(inline) ? null : [];
  const triggers = text.slice(on.index + on[0].length + 1).split(/^\S/m)[0];
  const push = /^ {2}push:[ \t]*(?:#.*)?$/m.exec(triggers);
  if (!push) return [];
  const block = triggers.slice(push.index + push[0].length + 1).split(/^ {0,3}\S/m)[0];
  const branches = listAt(block, 'branches');
  if (branches) return branches;
  const ignored = listAt(block, 'branches-ignore');
  if (ignored) return ['**', ...ignored.map((name) => `!${name}`)];
  // A tags filter without a branches one: no branch push runs the workflow
  return /^ {4}tags(-ignore)?:/m.test(block) ? [] : null;
}

/** pushBranches for a flow mapping on one line: `{ push: { branches: [main] }, pull_request: {} }`. */
function inlinePushBranches(inline) {
  if (!/[{,]\s*['"]?push['"]?\s*:/.test(inline)) return [];
  const filter = /[{,]\s*['"]?push['"]?\s*:\s*\{([^{}]*)\}/.exec(inline)?.[1];
  // push: null, push: {} or a form it cannot read: every branch push
  if (!filter) return null;
  const list = (key) =>
    new RegExp(`(?:^|,)\\s*['"]?${key}['"]?\\s*:\\s*\\[([^\\]]*)\\]`)
      .exec(filter)?.[1]
      .split(',')
      .map((name) => scalar(name.trim()))
      .filter(Boolean) ?? null;
  const branches = list('branches');
  if (branches) return branches;
  const ignored = list('branches-ignore');
  if (ignored) return ['**', ...ignored.map((name) => `!${name}`)];
  return /(?:^|,)\s*['"]?tags(-ignore)?['"]?\s*:/.test(filter) ? [] : null;
}

/**
 * The values of a `key:` list inside the push block, as a flow or block list, or null without that key. A comment may
 * follow the key, and comments or blank lines may sit between the items.
 */
function listAt(block, key) {
  const flow = new RegExp(`^ {4}${key}:[ \\t]*\\[([^\\]]*)\\]`, 'm').exec(block);
  const list = flow
    ? flow[1].split(',')
    : (new RegExp(`^ {4}${key}:[ \\t]*(?:#.*)?\\n((?:[ \\t]*(?:#.*)?\\n| {4,}- .*\\n?)*)`, 'm')
        .exec(block)?.[1]
        .split('\n')
        .filter((line) => /^\s*- /.test(line))
        .map((line) => line.replace(/^\s*- /, '')) ?? null);
  return list?.map((name) => scalar(name.trim())).filter(Boolean) ?? null;
}

/**
 * Whether a push to the branch runs the workflow, given the patterns of pushBranches (null: every branch). Follows
 * GitHub's filter patterns: * (no /), **, ?, +, [...], \ to escape, and ! to exclude, where the last matching pattern
 * wins.
 */
export function runsOnPush(patterns, branch) {
  if (!patterns) return true;
  let runs = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (matchesGlob(negated ? pattern.slice(1) : pattern, branch)) runs = !negated;
  }
  return runs;
}

// ?, + and [...] mean the same in a regular expression; a pattern that is not a valid one (an unclosed [) is compared
// as it is written
function matchesGlob(pattern, branch) {
  const source = pattern.replace(/\\(.)|\*\*|\*|[.(){}|^$]/g, (token, escaped) => {
    if (escaped !== undefined) return escaped.replace(/[^\w/-]/, '\\$&');
    if (token === '**') return '.*';
    if (token === '*') return '[^/]*';
    return `\\${token}`;
  });
  try {
    return new RegExp(`^${source}$`).test(branch);
  } catch {
    return pattern === branch;
  }
}

/** Value of a single-line input, without a trailing comment or quotes. */
export function scalar(raw) {
  if (raw === undefined) return undefined;
  const quoted = /^(['"])(.*?)\1/.exec(raw);
  if (quoted) return quoted[2];
  return raw.replace(/\s+#.*$/, '');
}

/**
 * A boolean input: true unless it is false (in any case, as GitHub reads False and FALSE too), undefined when the file
 * does not set it (so the default applies).
 */
export function flagOf(raw) {
  return raw === undefined ? undefined : scalar(raw).toLowerCase() !== 'false';
}

/** A JSON list input such as '["production"]', or null. */
export function listOf(raw) {
  try {
    const value = JSON.parse(scalar(raw));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The version (`v2`) of the reusable workflow `ref` (at any version) the file calls with a `uses:` key, or null: a
 * commented line or a mention elsewhere does not count, and quotes around the value are not part of it.
 */
export function usesRef(content, ref) {
  const path = unversioned(ref).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`^\\s*(?:-\\s*)?uses:\\s*['"]?${path}([^\\s'"#]+)`, 'm').exec(lf(content))?.[1] ?? null;
}

/** A workflow reference without its version: `owner/repo/path@`. */
export function unversioned(ref) {
  return ref.slice(0, ref.indexOf('@') + 1);
}

/**
 * The example workflow up to its inputs: everything setup writes besides the `with:` block. Pushes to the
 * repository's default branch (and to the production branch, when it has one) run the tests and the deploys, so the
 * example's `main` becomes those branches.
 */
export async function templateBase(branch = 'main', productionBranch = null, example = 'project.yml') {
  const template = await readFile(join(packageRoot, 'examples', example), 'utf8');
  const cut = template.indexOf(OPTIONAL_MARKER);
  const branches = productionBranch ? `${branch}, ${productionBranch}` : branch;
  return (cut === -1 ? template : template.slice(0, cut))
    .trimEnd()
    .replace('branches: [main]', `branches: [${branches}]`);
}

/**
 * A template base followed by its `with:` block, from [input, raw value] pairs (multi-line values as parseInputs keeps
 * them), and what the existing file has after the pipeline job (afterInputs).
 */
export function withInputs(base, inputs, after = '') {
  const block = inputs.length
    ? ['    with:', ...inputs.map(([key, value]) => `      ${key}: ${value}`)].join('\n')
    : '';
  return `${base}\n${block ? `${block}\n` : ''}${after ? `\n${after}\n` : ''}`;
}

/**
 * Whether an existing workflow file has lines outside its `with:` block that setup would replace with `base`. What
 * follows the pipeline job is kept (afterInputs).
 */
export function hasChangesOutsideInputs(content, base) {
  const lines = lf(content).split('\n');
  const existing = lines.slice(0, pipelineEnd(lines)).join('\n');
  const cut = existing.search(new RegExp(WITH.source, 'm'));
  return (cut === -1 ? existing : existing.slice(0, cut)).trimEnd() !== base;
}

/**
 * The stack the workflow file names in its `stack:` input, in lowercase as GitHub compares it (`Laravel` runs as
 * laravel), or null (the entry points default to laravel).
 */
export function stackOf(inputs) {
  return scalar(inputs.stack)?.toLowerCase() || null;
}

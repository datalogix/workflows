import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LANGUAGE } from '../../lib/claude.js';
import { packageRoot } from '../../lib/project.js';
import { TOOL_INPUTS, toolAnswers, toolInputs } from '../../lib/tools.js';
import {
  afterInputs,
  flagOf,
  hasJob,
  jobText,
  lf,
  parseInputs,
  scalar,
  stackOf,
  templateBase,
  upToPipeline,
  withInputs,
  withoutJob,
} from '../../lib/workflow-file.js';

// The workflow file of a package calls package.yml, at the same path as a project's
export const PACKAGE_REF = 'datalogix/workflows/.github/workflows/package.yml@v2';

// The job of the package's workflow file that calls package-claude.yml: the Claude layers and the risk gate, with the
// permissions they need, apart from the tests (package.yml), which keep contents: read
export const CLAUDE_JOB = 'claude';

// The job of the package's workflow file that calls package-release.yml: the release pull request, the tag, the GitHub
// release and, for js, npm, on pushes after the tests, with the permissions releases need. Its presence turns them on
export const RELEASE_JOB = 'release';

// The Claude layers and the risk gate a package turns on, by answer and input of the claude job (the layers question):
// off by default in package-claude.yml
export const PACKAGE_LAYERS = {
  claude: 'claude',
  review: 'review',
  securityReview: 'security-review',
  riskGate: 'risk-gate',
};
// The layers that run Claude, with its token, App and labels; the risk gate needs none of them
const CLAUDE_LAYERS = ['claude', 'review', 'securityReview'];

/** Whether the answers turn on any Claude layer. */
export const claudeOn = (a) => CLAUDE_LAYERS.some((answer) => a?.[answer] === true);

/** Whether the answers turn on any layer of the claude job: a Claude layer or the risk gate. */
export const layersOn = (a) => Object.keys(PACKAGE_LAYERS).some((answer) => a?.[answer] === true);

/**
 * Answers implied by a package's workflow file: from the pipeline job, its stack, the tests it turns off, the public
 * API check and its lint and test tools; from the claude job (claudeInputs), the layers it turns on (off unless the
 * input is true) and the team language.
 */
export function packageAnswers(inputs, claudeInputs = {}) {
  return {
    stack: stackOf(inputs),
    tests: flagOf(inputs.tests),
    coverage: flagOf(inputs.coverage),
    ...Object.fromEntries(
      Object.entries(PACKAGE_LAYERS).map(([answer, input]) => [
        answer,
        scalar(claudeInputs[input])?.toLowerCase() === 'true',
      ]),
    ),
    language: scalar(claudeInputs.language) || DEFAULT_LANGUAGE,
    apiCheck: scalar(inputs['api-check'])?.toLowerCase() === 'true',
    ...toolAnswers(inputs),
  };
}

/**
 * packageAnswers of a whole workflow file: the inputs of its pipeline job and of its claude job, and whether it has the
 * release job (release). The team language is the claude job's, else the release job's.
 */
export function workflowAnswers(inputs, workflow = '') {
  const claudeInputs = parseInputs(workflow, CLAUDE_JOB);
  const releaseInputs = parseInputs(workflow, RELEASE_JOB);
  const language = scalar(claudeInputs.language) || scalar(releaseInputs.language) || DEFAULT_LANGUAGE;
  return { ...packageAnswers(inputs, claudeInputs), language, release: hasJob(workflow, RELEASE_JOB) };
}

/** The example package workflow up to its inputs: examples/package-claude.yml with a layer on, else package.yml. */
export async function packageTemplate(branch, withLayers = false) {
  if (!withLayers) return templateBase(branch, null, 'package.yml');
  return upToPipeline(await templateBase(branch, null, 'package-claude.yml'));
}

/** A job of an example up to its with: line, which setup writes after. */
async function jobHead(example, name) {
  const template = await readFile(join(packageRoot, 'examples', example), 'utf8');
  const job = jobText(template, name);
  return job.slice(0, job.search(/^ {4}with:/m)).trimEnd();
}

/** The inputs of the claude job that setup writes: the layers that are on, the stack, the language and count-author. */
function claudeJobInputs(answers) {
  const inputs = [['tests-result', '${{ needs.pipeline.result }}']];
  // laravel is the default of package-claude.yml: only another stack is written
  if (answers.stack && answers.stack !== 'laravel') inputs.push(['stack', answers.stack]);
  for (const [answer, input] of Object.entries(PACKAGE_LAYERS)) {
    // Off is package-claude.yml's default: only a layer that is on is written
    if (answers[answer] === true) inputs.push([input, 'true']);
  }
  if (answers.language?.trim() && answers.language.trim() !== DEFAULT_LANGUAGE)
    inputs.push(['language', answers.language.trim()]);
  // A solo maintainer cannot approve their own pull requests: the risk gate counts them as one approval
  if (answers.riskGate === true && answers.solo === true) inputs.push(['count-author', 'true']);
  return inputs;
}

// The inputs of the claude job setup manages; any other (model, approvals, ...) is kept
const CLAUDE_MANAGED = ['tests-result', 'stack', ...Object.values(PACKAGE_LAYERS), 'language', 'count-author'];

/** The claude job of the answers, with the other inputs of the existing claude job. */
async function claudeJob(answers, existing) {
  const kept = Object.entries(parseInputs(existing, CLAUDE_JOB)).filter(([key]) => !CLAUDE_MANAGED.includes(key));
  const inputs = [...claudeJobInputs(answers), ...kept];
  return [
    await jobHead('package-claude.yml', CLAUDE_JOB),
    '    with:',
    ...inputs.map(([key, value]) => `      ${key}: ${value}`),
  ].join('\n');
}

// The inputs of the release job setup manages; any other is kept
const RELEASE_MANAGED = ['stack', 'language'];

/** The release job of examples/package-release.yml with the stack, the language and the other existing inputs. */
async function releaseJob(answers, existing) {
  const current = parseInputs(existing, RELEASE_JOB);
  const kept = Object.entries(current).filter(([key]) => !RELEASE_MANAGED.includes(key));
  // The stack is always written, so the job has a with: block and package-release.yml knows a js package
  const stack = answers.stack ?? scalar(current.stack) ?? 'laravel';
  const inputs = [['stack', stack]];
  const language = answers.language?.trim() ?? scalar(current.language);
  if (language && language !== DEFAULT_LANGUAGE) inputs.push(['language', language]);
  return [
    await jobHead('package-release.yml', RELEASE_JOB),
    '    with:',
    ...[...inputs, ...kept].map(([key, value]) => `      ${key}: ${value}`),
  ].join('\n');
}

/**
 * A package's workflow file with pushes to the default branch, the lint, test and public API inputs of the answers in
 * the pipeline job and every other input of the existing file. With a layer on (or, when the layers question was not
 * asked, an existing claude job), the file is examples/package-claude.yml: its events, and the claude job with the
 * layers, the language and its other existing inputs. With every layer off, it is examples/package.yml, without the
 * claude job, so the file grants only contents: read as before the layers existed. With release on (or, when the
 * question was not asked, an existing release job), the release job of examples/package-release.yml follows.
 */
export async function renderPackageWorkflow(existing = '', branch = 'main', answers = {}) {
  const current = parseInputs(existing);
  // laravel is the default of package.yml: only another stack is written
  const stack = answers.stack && answers.stack !== 'laravel' ? { stack: answers.stack } : {};
  // Off is package.yml's default: written only when on, managed once the question was answered
  const apiCheck = answers.apiCheck === undefined ? [] : ['api-check'];
  const managed = [...(answers.stack ? ['stack'] : []), ...apiCheck, ...TOOL_INPUTS];
  const kept = Object.entries(current).filter(([key]) => !managed.includes(key));
  const inputs = [
    ...Object.entries(stack),
    ...(answers.apiCheck === true ? [['api-check', 'true']] : []),
    ...kept,
    ...Object.entries(toolInputs(answers, current)),
  ];

  // The layers are managed only once the layers question was answered; otherwise the existing claude job stays
  const answered = Object.keys(PACKAGE_LAYERS).some((answer) => answers[answer] !== undefined);
  const withLayers = answered ? layersOn(answers) : hasJob(existing, CLAUDE_JOB);
  const job = !withLayers
    ? ''
    : answered
      ? await claudeJob(answers, existing)
      : (jobText(lf(existing), CLAUDE_JOB) ?? '');
  // Releases: on when answered, else as the existing file has them
  const withRelease = answers.release === undefined ? hasJob(existing, RELEASE_JOB) : answers.release === true;
  const release = !withRelease
    ? ''
    : answers.release === undefined
      ? (jobText(lf(existing), RELEASE_JOB) ?? '')
      : await releaseJob(answers, existing);
  const after = withoutJob(withoutJob(afterInputs(existing), CLAUDE_JOB), RELEASE_JOB);
  return withInputs(
    await packageTemplate(branch, withLayers),
    inputs,
    [job, release, after].filter(Boolean).join('\n\n'),
  );
}

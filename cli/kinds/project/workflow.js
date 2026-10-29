import {
  afterInputs,
  flagOf,
  listOf,
  parseInputs,
  scalar,
  stackOf,
  templateBase,
  withInputs,
} from '../../lib/workflow-file.js';
import { TOOL_INPUTS, toolAnswers, toolInputs } from '../../lib/tools.js';

export const PROJECT_REF = 'datalogix/workflows/.github/workflows/project.yml@v2';
// Default of the language input of project.yml
export const DEFAULT_LANGUAGE = 'pt-BR';

/** Inputs the setup command manages; any other input in an existing file is kept as it is. */
const MANAGED = [
  'review',
  'security-review',
  'risk-gate',
  'fix-ci',
  'deploy',
  'staging',
  'production',
  'production-branch',
  'approvals-medium',
  'approvals-high',
  'count-author',
  'github-deployments',
  'incidents',
  'incident-environments',
  'incident-types',
  'language',
  'js',
  ...TOOL_INPUTS,
];

// The Claude workflows and the risk gate a project turns off, by answer and input (the layers question)
export const LAYERS = { review: 'review', securityReview: 'security-review', riskGate: 'risk-gate', fixCi: 'fix-ci' };
// Defaults of the approvals inputs of project.yml
const APPROVALS = { approvalsMedium: ['approvals-medium', '1'], approvalsHigh: ['approvals-high', '1'] };

/** Answers implied by a project's workflow file, used as defaults when setup runs again. */
export function projectAnswers(inputs) {
  const environments = listOf(inputs['incident-environments']);
  const types = listOf(inputs['incident-types']);
  return {
    stack: stackOf(inputs),
    deploy: scalar(inputs.deploy) ?? 'none',
    staging: flagOf(inputs.staging),
    production: scalar(inputs.production) || 'auto',
    productionBranch: scalar(inputs['production-branch']) || null,
    solo: scalar(inputs['count-author'])?.toLowerCase() === 'true',
    githubDeployments: flagOf(inputs['github-deployments']),
    incidents: flagOf(inputs.incidents),
    incidentStaging: environments ? environments.includes('staging') : undefined,
    incidentPerformance: types ? types.includes('performance') : undefined,
    tests: flagOf(inputs.tests),
    ...Object.fromEntries(Object.entries(LAYERS).map(([answer, input]) => [answer, flagOf(inputs[input])])),
    approvalsMedium: scalar(inputs['approvals-medium']) || null,
    approvalsHigh: scalar(inputs['approvals-high']) || null,
    js: flagOf(inputs.js),
    language: scalar(inputs.language) || DEFAULT_LANGUAGE,
    ...toolAnswers(inputs),
  };
}

/** The example project workflow (examples/project.yml) up to its inputs, as setup writes it for the existing file. */
export function projectTemplate(existing, branch) {
  return templateBase(branch, scalar(parseInputs(existing)['production-branch']) || null, 'project.yml');
}

/** The workflow file for the given answers, keeping unmanaged inputs of the existing file. */
export async function renderProjectWorkflow(answers, existing = '', branch = 'main') {
  const managed = {};
  const current = parseInputs(existing);
  // An input setup did not ask about (its answer is undefined) keeps its current value
  const keep = (input) => {
    if (current[input] !== undefined) managed[input] = current[input];
  };
  for (const [answer, input] of Object.entries(LAYERS)) {
    if (answers[answer] === undefined) keep(input);
    else if (answers[answer] === false) managed[input] = 'false';
  }
  if (answers.deploy && answers.deploy !== 'none') {
    managed.deploy = answers.deploy;
    if (answers.staging === false) managed.staging = 'false';
    else if (answers.productionBranch) managed['production-branch'] = answers.productionBranch;
    if (answers.production === undefined) keep('production');
    else if (answers.production !== 'auto') managed.production = answers.production;
    if (answers.githubDeployments === false) managed['github-deployments'] = 'false';
  }
  for (const [answer, [input, defaultValue]] of Object.entries(APPROVALS)) {
    if (answers[answer] === undefined) keep(input);
    else if (String(answers[answer]).trim() !== defaultValue) managed[input] = String(answers[answer]).trim();
  }
  if (answers.solo) managed['count-author'] = 'true';
  if (answers.incidents === false) managed.incidents = 'false';
  // The lists keep values setup does not ask about (another environment, a list set when there was no staging)
  const list = (input, defaults, value, answer) => {
    if (answer === undefined) {
      if (current[input] !== undefined) managed[input] = current[input];
      return;
    }
    const existingList = listOf(current[input]) ?? defaults;
    const values = answer ? [...new Set([...existingList, value])] : existingList.filter((item) => item !== value);
    const sameAsDefaults = values.length === defaults.length && defaults.every((item) => values.includes(item));
    if (!sameAsDefaults) managed[input] = `'${JSON.stringify(values)}'`;
  };
  list('incident-environments', ['production', 'staging'], 'staging', answers.incidentStaging);
  list('incident-types', ['exception', 'performance'], 'performance', answers.incidentPerformance);
  if (answers.language === undefined) {
    if (current.language !== undefined) managed.language = current.language;
  } else if (answers.language.trim() !== DEFAULT_LANGUAGE) {
    managed.language = answers.language.trim();
  }
  if (answers.js === undefined) keep('js');
  else if (answers.js === false) managed.js = 'false';
  Object.assign(managed, toolInputs(answers, current));

  const kept = Object.entries(current).filter(([key]) => !MANAGED.includes(key));
  const base = await templateBase(branch, managed['production-branch'], 'project.yml');
  return withInputs(base, [...Object.entries(managed), ...kept], afterInputs(existing));
}

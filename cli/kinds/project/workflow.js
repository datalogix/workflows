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

export const PROJECT_REF = 'datalogix/workflows/.github/workflows/project.yml@v2';
// Default of the language input of project.yml
export const DEFAULT_LANGUAGE = 'pt-BR';

/** Inputs the setup command manages; any other input in an existing file is kept as it is. */
const MANAGED = [
  'deploy',
  'staging',
  'production-branch',
  'count-author',
  'incidents',
  'incident-environments',
  'incident-types',
  'language',
];

/** Answers implied by a project's workflow file, used as defaults when setup runs again. */
export function projectAnswers(inputs) {
  const environments = listOf(inputs['incident-environments']);
  const types = listOf(inputs['incident-types']);
  return {
    stack: stackOf(inputs),
    deploy: scalar(inputs.deploy) ?? 'none',
    staging: flagOf(inputs.staging),
    productionBranch: scalar(inputs['production-branch']) || null,
    solo: scalar(inputs['count-author'])?.toLowerCase() === 'true',
    incidents: flagOf(inputs.incidents),
    incidentStaging: environments ? environments.includes('staging') : undefined,
    incidentPerformance: types ? types.includes('performance') : undefined,
    tests: flagOf(inputs.tests),
    securityReview: flagOf(inputs['security-review']),
    riskGate: flagOf(inputs['risk-gate']),
    language: scalar(inputs.language) || DEFAULT_LANGUAGE,
  };
}

/** The example project workflow (examples/project.yml) up to its inputs, as setup writes it for the existing file. */
export function projectTemplate(existing, branch) {
  return templateBase(branch, scalar(parseInputs(existing)['production-branch']) || null, 'project.yml');
}

/** The workflow file for the given answers, keeping unmanaged inputs of the existing file. */
export async function renderProjectWorkflow(answers, existing = '', branch = 'main') {
  const managed = {};
  if (answers.deploy && answers.deploy !== 'none') {
    managed.deploy = answers.deploy;
    if (answers.staging === false) managed.staging = 'false';
    else if (answers.productionBranch) managed['production-branch'] = answers.productionBranch;
  }
  if (answers.solo) managed['count-author'] = 'true';
  const current = parseInputs(existing);
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

  const kept = Object.entries(current).filter(([key]) => !MANAGED.includes(key));
  const base = await templateBase(branch, managed['production-branch'], 'project.yml');
  return withInputs(base, [...Object.entries(managed), ...kept], afterInputs(existing));
}

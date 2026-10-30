import { describe, expect, test } from 'vitest';
import { callsTo, runScript } from './fakes.js';

const FILE = '.github/workflows/datalogix.yml';
const AT_MERGE = `contents/${FILE.replaceAll('.', '\\.')}\\?ref=abc123`;
const AT_MAIN = `contents/${FILE.replaceAll('.', '\\.')}\\?ref=main`;

const workflowFile = ({ env = {}, gh = [] } = {}) =>
  runScript('workflow-file/workflow-file.sh', {
    env: {
      GITHUB_WORKFLOW_REF: `datalogix/app/${FILE}@refs/pull/7/merge`,
      MERGE_SHA: 'abc123',
      DEFAULT_BRANCH: 'main',
      ...env,
    },
    gh,
  });

const notFound = { code: 1, stderr: 'gh: Not Found (HTTP 404)' };

describe('workflow file', () => {
  test('outputs the path of the calling workflow and unchanged when both copies are the same', async () => {
    const result = await workflowFile({
      gh: [
        { match: AT_MERGE, stdout: { sha: 'same' } },
        { match: AT_MAIN, stdout: { sha: 'same' } },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({ path: FILE, changed: 'false' });
    expect(result.stdout).not.toContain('::warning::');
  });

  test('says changed and warns when the copies differ', async () => {
    const result = await workflowFile({
      gh: [
        { match: AT_MERGE, stdout: { sha: 'pr' } },
        { match: AT_MAIN, stdout: { sha: 'main' } },
      ],
    });

    expect(result.outputs.changed).toBe('true');
    expect(result.stdout).toContain(`::warning::${FILE} in this pull request is not the same as on the default branch`);
  });

  test('says changed when the default branch has no copy yet', async () => {
    const result = await workflowFile({
      gh: [
        { match: AT_MERGE, stdout: { sha: 'pr' } },
        { match: AT_MAIN, ...notFound },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.outputs.changed).toBe('true');
  });

  test.each([
    ['the pull request', AT_MERGE],
    ['the default branch', AT_MAIN],
  ])('says unchanged and warns when %s cannot be read', async (_, match) => {
    const result = await workflowFile({
      gh: [
        { match, code: 1, stderr: 'HTTP 502: Bad Gateway' },
        { match: 'contents/', stdout: { sha: 'other' } },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.outputs.changed).toBe('false');
    expect(result.stdout).toContain(`::warning::Could not compare ${FILE} with the default branch's copy: HTTP 502`);
  });

  test('says unchanged without reading outside a pull request', async () => {
    const result = await workflowFile({ env: { MERGE_SHA: '' } });

    expect(result.outputs).toEqual({ path: FILE, changed: 'false' });
    expect(callsTo(result, 'gh')).toEqual([]);
  });
});

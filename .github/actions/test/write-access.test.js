import { describe, expect, test } from 'vitest';
import { runScript, unmatchedReads } from './fakes.js';

const PERMISSION = 'collaborators/alice/permission';

async function writeAccess(rule) {
  const result = await runScript('write-access/write-access.sh', {
    env: { SENDER: 'alice' },
    gh: [{ match: PERMISSION, ...rule }],
  });
  expect(unmatchedReads(result)).toEqual([]);
  return result;
}

describe('write access', () => {
  test.each(['admin', 'maintain', 'write'])('lets %s through', async (permission) => {
    const result = await writeAccess({ stdout: { permission } });

    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({});
    expect(result.stdout).not.toContain('::notice::');
  });

  test.each(['triage', 'read', 'none'])('skips %s with a notice', async (permission) => {
    const result = await writeAccess({ stdout: { permission } });

    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({ skip: 'true' });
    expect(result.stdout).toContain(`::notice::alice needs write access for Claude to run (has '${permission}')`);
  });

  test('skips a user without access to the repository', async () => {
    const result = await writeAccess({ code: 1, stderr: 'gh: Not Found (HTTP 404)' });

    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({ skip: 'true' });
    expect(result.stdout).toContain("(has 'none')");
  });

  test('fails on any other error, which is not a lack of access', async () => {
    const result = await writeAccess({ code: 1, stderr: 'gh: Server Error (HTTP 500)' });

    expect(result.code).toBe(1);
    expect(result.outputs).toEqual({});
    expect(result.stdout).toContain('::error::Could not read the permission of alice: gh: Server Error (HTTP 500)');
  });
});

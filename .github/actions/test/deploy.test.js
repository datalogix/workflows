import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const sha = (char) => char.repeat(40);

const ENV = {
  MODE: 'deploy',
  PROVIDER: 'forge',
  ENVIRONMENT: 'production',
  DEPLOY_HOOK: 'https://forge.test/hook',
  HEALTH_URL: 'https://app.test/up',
  NIGHTWATCH_TOKEN: '',
  BRANCH: 'main',
  RUN_URL: 'https://github.com/datalogix/app/actions/runs/1',
  GITHUB_SHA: sha('c'),
  MAX_FAILURES: '3',
  MINUTES: '10',
  SETTLE: '0',
};

// Release history refs, as the matching-refs API returns them: [time, sha]
const history = (entries) =>
  entries.map(([time, commit]) => ({ ref: `refs/datalogix/deploys/production/${time}`, object: { sha: commit } }));
const rolledBack = (commits) =>
  commits.map((commit) => ({ ref: `refs/datalogix/rolled-back/production/${commit}`, object: { sha: commit } }));

async function step(name, { env = {}, deploys = [], rejected = [], gh = [], curl = [] } = {}) {
  const result = await runScript('deploy/deploy.sh', {
    args: [name],
    env: { ...ENV, ...env },
    gh: [
      ...gh,
      // No live ref yet: GitHub answers 404
      { match: 'git/ref/datalogix/live/production$', code: 1, stderr: 'HTTP 404: Not Found' },
      { match: 'matching-refs/datalogix/deploys/', stdout: history(deploys) },
      { match: 'matching-refs/datalogix/rolled-back/', stdout: rolledBack(rejected) },
    ],
    curl,
  });
  expect(unmatchedReads(result)).toStrictEqual([]);
  return result;
}

describe('check', () => {
  test('check rejects a rollback asked by someone without write access', async () => {
    const gh = (permission) => [{ match: 'collaborators/ana/permission', stdout: { permission } }];
    const env = { MODE: 'rollback', SENDER: 'ana' };
    const triage = await step('check', { env, gh: gh('triage') });
    expect(triage.code).toBe(1);
    expect(triage.stdout).toMatch(/ana needs write access to roll back production \(has 'triage'\)/);
    expect((await step('check', { env, gh: gh('write') })).code).toBe(0);
  });

  test('check rejects a rollback when the permission cannot be read', async () => {
    const result = await step('check', {
      env: { MODE: 'rollback', SENDER: 'ana' },
      gh: [{ match: 'collaborators/ana/permission', code: 1, stderr: 'HTTP 502' }],
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Could not read the permission of ana to roll back production: HTTP 502/);

    const gone = await step('check', {
      env: { MODE: 'rollback', SENDER: 'ana' },
      gh: [{ match: 'collaborators/ana/permission', code: 1, stderr: 'HTTP 404: Not Found' }],
    });
    expect(gone.code).toBe(1);
    expect(gone.stdout).toMatch(/ana needs write access to roll back production \(has 'none'\)/);
  });

  test('check rejects an unknown provider or mode and a missing health URL', async () => {
    const provider = await step('check', { env: { PROVIDER: 'heroku' } });
    expect(provider.code).toBe(1);
    expect(provider.stdout).toMatch(/provider must be one of cloud, forge, vercel, got 'heroku'/);
    // The name becomes a path, so it never leaves providers/
    const path = await step('check', { env: { PROVIDER: '../monitoring/nightwatch' } });
    expect(path.code).toBe(1);
    expect(path.stdout).toMatch(/provider must be one of cloud, forge, vercel, got '\.\.\/monitoring\/nightwatch'/);

    const mode = await step('check', { env: { MODE: 'redeploy' } });
    expect(mode.code).toBe(1);
    expect(mode.stdout).toMatch(/mode must be deploy or rollback, got 'redeploy'/);

    const health = await step('check', { env: { HEALTH_URL: '' } });
    expect(health.code).toBe(1);
    expect(health.stdout).toMatch(/Add the HEALTH_URL variable to the production environment/);
  });

  test('check rejects watch and settle settings that are not whole numbers, before deploying', async () => {
    for (const [env, message] of [
      [{ MINUTES: '2.5' }, /watch-minutes must be a whole number of at least 1, got '2.5'/],
      [{ MINUTES: '0' }, /watch-minutes must be a whole number of at least 1, got '0'/],
      [{ SETTLE: '30.5' }, /settle-seconds must be a whole number of at least 0, got '30.5'/],
      [{ MAX_FAILURES: '' }, /max-failures must be a whole number of at least 1, got ''/],
    ]) {
      const result = await step('check', { env });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(message);
    }
    expect((await step('check', { env: { MINUTES: '08', SETTLE: '45' } })).code).toBe(0);
  });

  test('check asks for the missing deploy hook', async () => {
    const result = await step('check', { env: { DEPLOY_HOOK: '' } });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Add the DEPLOY_HOOK secret to the production environment/);
  });
});

describe('choose', () => {
  test('choose deploys the current commit', async () => {
    const result = await step('choose');
    expect(result.outputs.sha).toBe(sha('c'));
  });

  test('choose rolls back to the newest good release before the live one, skipping rolled-back releases', async () => {
    const result = await step('choose', {
      env: { MODE: 'rollback' },
      deploys: [
        [100, sha('a')],
        [300, sha('c')],
        [200, sha('b')],
        [50, sha('0')],
      ],
      rejected: [sha('b')],
    });
    expect(result.code).toBe(0);
    expect(result.outputs).toStrictEqual({ from: sha('c'), sha: sha('a') });
    // Marked only once the rollback is triggered
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringContaining(`rolled-back/production/${sha('c')}`));
  });

  test('choose rolls back from the live release even when it failed and stayed', async () => {
    const result = await step('choose', {
      env: { MODE: 'rollback' },
      deploys: [
        [100, sha('a')],
        [200, sha('b')],
      ],
      gh: [{ match: 'git/ref/datalogix/live/production$', stdout: { object: { sha: sha('x') } } }],
    });
    expect(result.code).toBe(0);
    expect(result.outputs).toStrictEqual({ from: sha('x'), sha: sha('b') });
  });

  test('choose fails when the release history cannot be read', async () => {
    const result = await step('choose', {
      env: { MODE: 'rollback' },
      gh: [{ match: 'matching-refs/datalogix/deploys/', code: 1, stderr: 'HTTP 502' }],
    });
    expect(result.code).toBe(1);
    expect(result.outputs).toStrictEqual({});
    expect(result.stdout).not.toMatch(/No release of production recorded yet/);
    expect(result.stdout).toMatch(/::error::Cannot read the release history of production$/m);
  });

  test('choose fails when the live release cannot be read, instead of guessing it from the history', async () => {
    const result = await step('choose', {
      env: { MODE: 'rollback' },
      deploys: [
        [100, sha('e')],
        [200, sha('g')],
      ],
      gh: [{ match: 'git/ref/datalogix/live/production$', code: 1, stderr: 'HTTP 502: Bad Gateway' }],
    });
    // Guessing g as live would roll back to e and mark the healthy g as rolled back
    expect(result.code).toBe(1);
    expect(result.outputs).toStrictEqual({});
    expect(result.stderr).toMatch(/Cannot read the live release of production: HTTP 502/);
  });

  test('choose fails when there is nothing to roll back to', async () => {
    const result = await step('choose', { env: { MODE: 'rollback' }, deploys: [[100, sha('a')]] });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/No release of production before aaaaaaa to roll back to/);
  });

  test('choose fails when no release was recorded yet', async () => {
    const result = await step('choose', { env: { MODE: 'rollback' } });
    expect(result.code).toBe(1);
    expect(result.outputs).toStrictEqual({});
    expect(result.stdout).toMatch(
      /::error::No release of production recorded yet; the history starts with the first deploy made by this workflow/,
    );
  });
});

describe('deploy', () => {
  test('a rollback marks the release it leaves only after the hook accepted it', async () => {
    const env = { MODE: 'rollback', SHA: sha('a'), FROM: sha('c') };
    const marked = (result) =>
      callsTo(result, 'gh').filter((call) => call.includes(`rolled-back/production/${sha('c')}`));

    const accepted = await step('deploy', { env });
    expect(accepted.code).toBe(0);
    expect(marked(accepted)).toStrictEqual([
      `api repos/datalogix/app/git/refs -f ref=refs/datalogix/rolled-back/production/${sha('c')} -f sha=${sha('c')}`,
    ]);
    expect(callsTo(accepted, 'gh')).toContain(
      `api -X PATCH repos/datalogix/app/git/refs/datalogix/live/production -f sha=${sha('a')} -F force=true`,
    );

    const rejected = await step('deploy', { env, curl: [{ match: 'forge.test', codes: ['500'] }] });
    expect(rejected.code).toBe(1);
    expect(marked(rejected)).toStrictEqual([]);
    expect(callsTo(rejected, 'gh')).not.toContainEqual(expect.stringContaining('live/production'));
  });

  test('deploy creates the live ref the first time', async () => {
    const result = await step('deploy', {
      env: { SHA: sha('c') },
      gh: [{ match: '^api -X PATCH .*live/production', code: 1, stderr: 'HTTP 422: Reference does not exist' }],
    });
    expect(result.code).toBe(0);
    expect(callsTo(result, 'gh')).toContain(
      `api repos/datalogix/app/git/refs -f ref=refs/datalogix/live/production -f sha=${sha('c')}`,
    );
  });

  test('deploy warns when the live release cannot be recorded', async () => {
    const result = await step('deploy', {
      env: { SHA: sha('c') },
      gh: [
        { match: '^api -X PATCH .*live/production', code: 1, stderr: 'HTTP 422' },
        {
          match: '^api repos/datalogix/app/git/refs -f ref=refs/datalogix/live/production',
          code: 1,
          stderr: 'HTTP 502',
        },
      ],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/::warning::Could not record ccccccc as the live release of production/);
  });

  test('deploy triggers Forge with the exact commit and marks it in Nightwatch', async () => {
    const result = await step('deploy', { env: { SHA: sha('c'), NIGHTWATCH_TOKEN: 'token' } });
    expect(result.code).toBe(0);
    const [hook, nightwatch] = callsTo(result, 'curl');
    expect(hook).toMatch(/--max-time 60 .*forge_deploy_commit=c{40} .*commit=c{40} https:\/\/forge.test\/hook$/);
    // Forge deploys the branch head unless it is told the environment's branch
    expect(hook).toMatch(/ forge_deploy_branch=main /);
    expect(nightwatch).toMatch(
      /--fail --max-time 30 .*nightwatch.laravel.com\/api\/deployments .*"name": "production ccccccc"/s,
    );
    // The token goes in a header file, not in the arguments
    const call = result.calls.filter(([name]) => name === 'curl')[1];
    const header = call.indexOf('<header>');
    expect(call.slice(0, header).join(' ')).not.toContain('token');
    expect(call[header + 1]).toMatch(/^Authorization: Bearer token$/m);
  });

  test('deploy reports to Nightwatch only from Forge and with a token', async () => {
    const reported = (result) => callsTo(result, 'curl').filter((call) => call.includes('nightwatch.laravel.com'));
    const withoutToken = await step('deploy', { env: { SHA: sha('c') } });
    expect(withoutToken.code).toBe(0);
    expect(reported(withoutToken)).toStrictEqual([]);

    const cloud = await step('deploy', {
      env: { PROVIDER: 'cloud', DEPLOY_HOOK: 'https://cloud.test/hook', SHA: sha('c'), NIGHTWATCH_TOKEN: 'token' },
    });
    expect(cloud.code).toBe(0);
    expect(reported(cloud)).toStrictEqual([]);
  });

  test('deploy marks Nightwatch only when it is the monitoring service', async () => {
    const env = { SHA: sha('c'), NIGHTWATCH_TOKEN: 'token' };
    for (const monitoring of ['sentry', 'none', '../x']) {
      const result = await step('deploy', { env: { ...env, MONITORING: monitoring } });
      expect(result.code).toBe(0);
      expect(callsTo(result, 'curl').filter((call) => call.includes('nightwatch.laravel.com'))).toStrictEqual([]);
    }
  });

  test('deploy warns when Nightwatch rejects the deploy marker', async () => {
    const result = await step('deploy', {
      env: { SHA: sha('c'), NIGHTWATCH_TOKEN: 'token' },
      curl: [{ match: 'nightwatch', codes: ['401'] }],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/::warning::Could not report the deploy to Nightwatch/);
  });

  test('deploy triggers Laravel Cloud with the commit hash and fails when the hook rejects it', async () => {
    const curl = [{ match: 'cloud.test', codes: ['404'] }];
    const result = await step('deploy', {
      env: { PROVIDER: 'cloud', DEPLOY_HOOK: 'https://cloud.test/hook', SHA: sha('c') },
      curl,
    });
    expect(result.code).toBe(1);
    expect(callsTo(result, 'curl')[0]).toMatch(/commit_hash=c{40} https:\/\/cloud.test\/hook$/);
    expect(result.stdout).toMatch(/The deploy hook answered HTTP 404/);
  });

  test('deploy fails when the hook cannot be reached', async () => {
    const result = await step('deploy', { env: { SHA: sha('c') }, curl: [{ match: 'forge.test', codes: ['000'] }] });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/::error::The deploy hook answered HTTP 000/);
    // It may not have deployed: the live release stays as it was
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringContaining('live/production'));
  });
});

describe('watch', () => {
  test('watch records a healthy release and keeps the 30 newest', async () => {
    const deploys = Array.from({ length: 31 }, (_, i) => [1000 + i, sha('a')]);
    const result = await step('watch', {
      env: { SHA: sha('c'), MINUTES: '2' },
      deploys,
      curl: [{ match: 'app.test', codes: ['200', '500', '200'] }],
    });
    expect(result.code).toBe(0);
    expect(callsTo(result, 'curl')).toHaveLength(4);
    // Between the checks, not after the last one
    expect(callsTo(result, 'sleep')).toStrictEqual(['30', '30', '30']);
    const gh = callsTo(result, 'gh');
    expect(gh).toContainEqual(
      expect.stringMatching(new RegExp(`git/refs -f ref=refs/datalogix/deploys/production/\\S+ -f sha=${sha('c')}$`)),
    );
    expect(gh.filter((call) => call.includes('DELETE'))).toStrictEqual([
      'api -X DELETE repos/datalogix/app/git/refs/datalogix/deploys/production/1000',
    ]);
  });

  test('watch fails after max-failures consecutive errors without recording the release', async () => {
    const result = await step('watch', {
      env: { SHA: sha('c'), MINUTES: '10' },
      curl: [{ match: 'app.test', codes: ['200', '502', '000', '503'] }],
    });
    expect(result.code).toBe(1);
    expect(callsTo(result, 'curl')).toHaveLength(4);
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringContaining('git/refs -f'));
  });

  test('watch follows a run of errors past the window, so fewer checks than max-failures do not pass a broken release', async () => {
    const result = await step('watch', {
      env: { SHA: sha('c'), MINUTES: '1' },
      curl: [{ match: 'app.test', codes: ['500'] }],
    });
    expect(result.code).toBe(1);
    expect(callsTo(result, 'curl')).toHaveLength(3);
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringContaining('git/refs -f'));
  });

  test('watch records a release whose errors at the end of the window stop', async () => {
    const result = await step('watch', {
      env: { SHA: sha('c'), MINUTES: '1' },
      curl: [{ match: 'app.test', codes: ['200', '500', '200'] }],
    });
    expect(result.code).toBe(0);
    expect(callsTo(result, 'curl')).toHaveLength(3);
    expect(callsTo(result, 'sleep')).toStrictEqual(['30', '30']);
    expect(result.stdout).toMatch(/Health check 1\/2: HTTP 200\n/);
    expect(result.stdout).toMatch(/Health check 3\/2: HTTP 200\n/);
  });

  test('watch removes the rolled-back marks of releases no longer in the history', async () => {
    const result = await step('watch', {
      env: { SHA: sha('c') },
      deploys: [[1000, sha('a')]],
      rejected: [sha('a'), sha('b')],
    });
    expect(result.code).toBe(0);
    expect(callsTo(result, 'gh').filter((call) => call.includes('DELETE'))).toStrictEqual([
      `api -X DELETE repos/datalogix/app/git/refs/datalogix/rolled-back/production/${sha('b')}`,
    ]);
  });

  test('the release history uses the environment name in lowercase', async () => {
    const result = await step('watch', { env: { ENVIRONMENT: 'Production', SHA: sha('c'), MINUTES: '1' } });
    expect(callsTo(result, 'gh')).toContainEqual(expect.stringContaining('-f ref=refs/datalogix/deploys/production/'));
  });

  test('watch keeps a healthy release when the history cannot be recorded', async () => {
    const result = await step('watch', {
      env: { SHA: sha('c'), MINUTES: '1' },
      gh: [{ match: '^api repos/datalogix/app/git/refs -f ref=refs/datalogix/deploys', code: 1, stderr: 'HTTP 502' }],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/::warning::Could not record ccccccc in the release history of production/);
  });

  test('watch reads the minutes as a decimal number, also with a leading zero', async () => {
    // 08 is not an octal number: read as one, the window would end before any check and pass the release
    const healthy = await step('watch', { env: { SHA: sha('c'), MINUTES: '08' } });
    expect(healthy.code).toBe(0);
    expect(callsTo(healthy, 'curl')).toHaveLength(16);

    const failing = await step('watch', {
      env: { SHA: sha('c'), MINUTES: '08' },
      curl: [{ match: 'app.test', codes: ['500'] }],
    });
    expect(failing.code).toBe(1);
    expect(callsTo(failing, 'curl')).toHaveLength(3);
    expect(callsTo(failing, 'gh')).not.toContainEqual(expect.stringContaining('git/refs -f'));
  });

  test('watch keeps the rolled-back marks when the history cannot be read to clean them', async () => {
    const deletes = (result) => callsTo(result, 'gh').filter((call) => call.includes('DELETE'));
    // A failed read would look like an empty history, and every mark would be removed
    const env = { SHA: sha('c'), MINUTES: '1' };
    const rejected = [sha('a'), sha('b')];

    const failed = await step('watch', {
      env,
      rejected,
      gh: [{ match: 'matching-refs/datalogix/deploys/', code: 1, stderr: 'HTTP 502' }],
    });
    expect(failed.code).toBe(0);
    expect(deletes(failed)).toStrictEqual([]);
    // One read of the history serves the pruning and the rolled-back marks
    expect(callsTo(failed, 'gh').filter((call) => call.includes('matching-refs/datalogix/deploys/'))).toHaveLength(1);
  });
});

describe('rollback', () => {
  test('rollback returns to the last good release other than the failed commit', async () => {
    const result = await step('rollback', {
      deploys: [
        [200, sha('c')],
        [100, sha('a')],
      ],
    });
    expect(result.code).toBe(0);
    expect(result.outputs.target).toBe(sha('a'));
    expect(callsTo(result, 'curl')[0]).toMatch(/forge_deploy_commit=a{40}/);
    expect(callsTo(result, 'sleep')[0]).toStrictEqual('120');
    // Healthy again: recorded in the history, so a later rollback can return to it
    expect(callsTo(result, 'gh')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^api repos/datalogix/app/git/refs -f ref=refs/datalogix/deploys/production/\\S+ -f sha=${sha('a')}$`,
        ),
      ),
    );
  });

  test('rollback waits as long as the deploy, so a slow one is not watched before it ends', async () => {
    const result = await step('rollback', {
      env: { SETTLE: '600' },
      deploys: [
        [200, sha('c')],
        [100, sha('a')],
      ],
    });
    expect(result.code).toBe(0);
    expect(callsTo(result, 'sleep')[0]).toStrictEqual('600');
  });

  test('rollback marks the failed commit as rolled back once the hook accepts the rollback', async () => {
    // Recorded as good before, deployed again (Re-run jobs) and failing now
    const result = await step('rollback', {
      deploys: [
        [200, sha('c')],
        [100, sha('a')],
      ],
    });
    expect(result.code).toBe(0);
    expect(callsTo(result, 'gh')).toContainEqual(
      `api repos/datalogix/app/git/refs -f ref=refs/datalogix/rolled-back/production/${sha('c')} -f sha=${sha('c')}`,
    );

    const refused = await step('rollback', {
      deploys: [
        [200, sha('c')],
        [100, sha('a')],
      ],
      curl: [{ match: 'forge.test', codes: ['500'] }],
    });
    expect(refused.code).toBe(1);
    expect(callsTo(refused, 'gh')).not.toContainEqual(expect.stringContaining(`ref=refs/datalogix/rolled-back/`));
  });

  test('rollback fails with a reason when the release history cannot be read', async () => {
    const result = await step('rollback', {
      gh: [{ match: 'matching-refs/datalogix/deploys/', code: 1, stderr: 'HTTP 502' }],
    });
    expect(result.code).toBe(1);
    expect(result.outputs.target).toBe('');
    expect(result.stdout).toMatch(/::error::Cannot read the release history of production to roll back/);
    expect(callsTo(result, 'curl')).toHaveLength(0);
  });

  test('rollback fails when there is no previous good release', async () => {
    const result = await step('rollback', { deploys: [[100, sha('c')]] });
    expect(result.code).toBe(1);
    expect(result.outputs.target).toBe('');
    expect(result.stdout).toMatch(/No previous good release of production to roll back to/);
    expect(callsTo(result, 'curl')).toHaveLength(0);
  });

  test('rollback fails without recording the release when health checks still fail', async () => {
    const result = await step('rollback', {
      deploys: [
        [200, sha('c')],
        [100, sha('a')],
      ],
      curl: [{ match: 'app.test', codes: ['500'] }],
    });
    expect(result.code).toBe(1);
    expect(result.outputs.target).toBe(sha('a'));
    expect(result.stdout).toMatch(/production is still failing after the rollback to aaaaaaa/);
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringContaining('git/refs -f ref=refs/datalogix/deploys'));
  });

  test('rollback reports the rollback to Nightwatch', async () => {
    const result = await step('rollback', {
      env: { NIGHTWATCH_TOKEN: 'token' },
      deploys: [
        [200, sha('c')],
        [100, sha('a')],
      ],
    });
    expect(result.code).toBe(0);
    expect(callsTo(result, 'curl').filter((call) => call.includes('nightwatch.laravel.com'))).toStrictEqual([
      expect.stringMatching(/"deploy": "a{40}".*"name": "production rollback to aaaaaaa"/s),
    ]);
  });
});

describe('settle', () => {
  test('settle waits for the provider unless told how long', async () => {
    const waited = async (env) => callsTo(await step('settle', { env }), 'sleep');
    expect(await waited({ PROVIDER: 'cloud' })).toStrictEqual(['300']);
    expect(await waited({ PROVIDER: 'forge' })).toStrictEqual(['120']);
    expect(await waited({ PROVIDER: 'cloud', SETTLE: '45' })).toStrictEqual(['45']);
  });
});

describe('open-issue', () => {
  test('open-issue says whether the automatic rollback worked', async () => {
    const result = await step('open-issue', { env: { ROLLBACK: 'success', TARGET: sha('a') } });
    const issue = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
    expect(issue).toMatch(/^issue create --repo datalogix\/app --title Deploy de ccccccc em production falhou/);
    expect(issue).toMatch(/revertido automaticamente para `aaaaaaa`/);
    // The rollback label would revert the healthy release the environment went back to
    expect(issue).not.toMatch(/--label/);
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^label create env:/));
  });

  test('open-issue names the monitoring service, when the project has one', async () => {
    const hint = async (monitoring) => {
      const result = await step('open-issue', { env: { ROLLBACK: 'failure', MONITORING: monitoring } });
      return callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
    };
    expect(await hint('nightwatch')).toMatch(/Verifique os erros no Nightwatch e os logs do deploy no forge\./);
    expect(await hint('sentry')).toMatch(/Verifique os erros no Sentry e os logs do deploy no forge\./);
    expect(await hint('none')).toMatch(/Verifique os logs do deploy no forge\. Para redeployar/);
  });

  test('open-issue labels the issue with its environment, so the rollback label reverts that one', async () => {
    const result = await step('open-issue', { env: { ENVIRONMENT: 'Staging', ROLLBACK: 'failure' } });
    const gh = callsTo(result, 'gh');
    expect(gh).toContainEqual(expect.stringMatching(/^label create env:staging /));
    expect(gh.find((call) => call.startsWith('issue create'))).toMatch(/ --label env:staging$/);
  });

  test('open-issue writes in English when the language is English', async () => {
    const result = await step('open-issue', { env: { LANGUAGE: 'en', ROLLBACK: 'failure', TARGET: sha('a') } });
    const gh = callsTo(result, 'gh');
    expect(gh).toContainEqual(
      expect.stringMatching(/^label create env:production .*--description Environment of the problem/),
    );
    const issue = gh.find((call) => call.startsWith('issue create'));
    expect(issue).toMatch(/^issue create --repo datalogix\/app --title Deploy of ccccccc to production failed/);
    expect(issue).toMatch(/automatic rollback to `aaaaaaa` did not help/);
  });

  test('open-issue says whether the automatic rollback failed, could not start or is off', async () => {
    const issue = async (ROLLBACK, LANGUAGE = '', TARGET = sha('a')) =>
      callsTo(await step('open-issue', { env: { ROLLBACK, TARGET, LANGUAGE } }), 'gh').find((call) =>
        call.startsWith('issue create'),
      );

    expect(await issue('failure')).toMatch(/\*\*A reversão automática para `aaaaaaa` não resolveu\*\*/);
    expect(await issue('failure', '', '')).toMatch(
      /\*\*A reversão automática não pôde começar\*\* .*; o ambiente continua com `ccccccc`/,
    );
    expect(await issue('')).toMatch(/A reversão automática está desligada; o ambiente continua com `ccccccc`/);

    expect(await issue('failure', 'en')).toMatch(/\*\*The automatic rollback to `aaaaaaa` did not help\*\*/);
    expect(await issue('failure', 'en', '')).toMatch(
      /\*\*The automatic rollback could not start\*\* .*; the environment still runs `ccccccc`/,
    );
    expect(await issue('', 'en')).toMatch(/The automatic rollback is off; the environment still runs `ccccccc`/);
  });
});

describe('report-rollback', () => {
  test('report-rollback comments on the issue and removes the label', async () => {
    const result = await step('report-rollback', {
      env: { ISSUE: '12', LABEL: 'rollback', RESULT: 'success', FROM: sha('c'), SHA: sha('a') },
    });
    const [comment, edit] = callsTo(result, 'gh');
    expect(comment).toMatch(/^issue comment 12 .*revertido de `ccccccc` para `aaaaaaa`/);
    expect(edit).toBe('issue edit 12 --repo datalogix/app --remove-label rollback');
  });

  test('report-rollback writes in English when the language is English', async () => {
    const result = await step('report-rollback', {
      env: { LANGUAGE: 'en', ISSUE: '12', LABEL: 'rollback', RESULT: 'failure', SHA: sha('a') },
    });
    expect(callsTo(result, 'gh')[0]).toMatch(/^issue comment 12 .*The rollback of production to `aaaaaaa` failed/);
  });

  test('report-rollback tells a failed hook apart from failed health checks', async () => {
    const report = async (RESULT, LANGUAGE = '') =>
      callsTo(
        await step('report-rollback', {
          env: { MODE: 'rollback', ISSUE: '5', LABEL: 'rollback', FROM: sha('c'), SHA: sha('a'), RESULT, LANGUAGE },
        }),
        'gh',
      ).find((call) => call.startsWith('issue comment'));

    expect(await report('failure')).toMatch(/falhou nos health checks/);
    expect(await report('cancelled')).toMatch(/foi disparada, mas a verificação foi interrompida/);
    expect(await report('skipped')).toMatch(/Não foi possível reverter/);
    expect(await report('')).toMatch(/Não foi possível reverter/);

    expect(await report('success', 'en')).toMatch(/rolled back from `ccccccc` to `aaaaaaa` and is responding normally/);
    expect(await report('failure', 'en')).toMatch(/failed the health checks/);
    expect(await report('cancelled', 'en')).toMatch(/was triggered, but the check was interrupted/);
    expect(await report('skipped', 'en')).toMatch(/Could not roll back/);
    expect(await report('', 'en')).toMatch(/Could not roll back/);
  });
});

describe('vercel', () => {
  const VERCEL = { PROVIDER: 'vercel', DEPLOY_HOOK: '', VERCEL_TOKEN: 'vercel-token', VERCEL_PROJECT: 'app' };
  const temp = () => mkdtemp(join(tmpdir(), 'runner-'));

  test('check needs the token and the project, not a deploy hook', async () => {
    expect((await step('check', { env: VERCEL })).code).toBe(0);
    const token = await step('check', { env: { ...VERCEL, VERCEL_TOKEN: '' } });
    expect(token.code).toBe(1);
    expect(token.stdout).toMatch(/Add the VERCEL_TOKEN secret to the production environment/);
    const project = await step('check', { env: { ...VERCEL, VERCEL_PROJECT: '' } });
    expect(project.code).toBe(1);
    expect(project.stdout).toMatch(/Add the VERCEL_PROJECT variable/);
  });

  test('deploy creates a deployment of the exact commit, with the token in a header file', async () => {
    const runner = await temp();
    const result = await step('deploy', {
      env: { ...VERCEL, SHA: sha('c'), RUNNER_TEMP: runner, VERCEL_TEAM_ID: 'team_1', ENVIRONMENT: 'Staging' },
      curl: [
        { match: 'api.vercel.com/v13/deployments', codes: ['200'], bodies: [{ id: 'dpl_1', readyState: 'QUEUED' }] },
      ],
    });
    expect(result.code).toBe(0);
    const [call] = callsTo(result, 'curl');
    expect(call).toMatch(/-X POST .*https:\/\/api\.vercel\.com\/v13\/deployments\?forceNew=1&teamId=team_1 /);
    expect(call).not.toMatch(/-H Authorization/);
    expect(call).toMatch(/<header> Authorization: Bearer vercel-token/);
    const body = JSON.parse(call.split('<stdin> ')[1]);
    expect(body).toStrictEqual({
      name: 'app',
      project: 'app',
      // The GitHub environment's name, lowercase
      target: 'staging',
      gitSource: { type: 'github', org: 'datalogix', repo: 'app', ref: 'main', sha: sha('c') },
    });
    expect(await readFile(join(runner, 'datalogix-vercel-staging'), 'utf8')).toBe('dpl_1\n');
  });

  test('deploy fails when Vercel refuses the deployment', async () => {
    const result = await step('deploy', {
      env: { ...VERCEL, SHA: sha('c'), RUNNER_TEMP: await temp() },
      curl: [{ match: 'api.vercel.com', codes: ['403'], bodies: [{ error: { message: 'Not authorized' } }] }],
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/::error::Vercel answered HTTP 403: Not authorized/);
  });

  test('records the deployment as live only once it is ready', async () => {
    const runner = await temp();
    const env = { ...VERCEL, SHA: sha('c'), RUNNER_TEMP: runner, SETTLE: '30' };
    const live = (result) => callsTo(result, 'gh').filter((call) => call.includes('datalogix/live/production'));
    const deploy = await step('deploy', {
      env,
      curl: [{ match: 'api.vercel.com/v13/deployments', codes: ['200'], bodies: [{ id: 'dpl_1' }] }],
    });
    expect(deploy.code).toBe(0);
    expect(live(deploy)).toStrictEqual([]);

    const failed = await step('settle', {
      env,
      curl: [{ match: 'v13/deployments/dpl_1', codes: ['200'], bodies: [{ readyState: 'ERROR' }] }],
    });
    expect(failed.code).toBe(1);
    expect(live(failed)).toStrictEqual([]);

    const ready = await step('settle', {
      env,
      curl: [{ match: 'v13/deployments/dpl_1', codes: ['200'], bodies: [{ readyState: 'READY' }] }],
    });
    expect(ready.code).toBe(0);
    expect(live(ready)).toContainEqual(expect.stringContaining(`sha=${sha('c')}`));
  });

  test('watch sends the protection bypass in a header file, never in the command line', async () => {
    const result = await step('watch', {
      env: { ...VERCEL, SHA: sha('c'), MINUTES: '1', VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret' },
      gh: [{ match: 'git/refs$', stdout: {} }],
    });
    const health = callsTo(result, 'curl').filter((call) => call.includes('app.test/up'));
    expect(health.length).toBeGreaterThan(0);
    for (const call of health) {
      expect(call.split(' <header> ')[0]).not.toContain('bypass-secret');
      expect(call).toContain('<header> x-vercel-protection-bypass: bypass-secret');
    }
    // Forge needs no header
    const forge = await step('watch', {
      env: { SHA: sha('c'), MINUTES: '1' },
      gh: [{ match: 'git/refs$', stdout: {} }],
    });
    expect(callsTo(forge, 'curl').every((call) => !call.includes('<header>'))).toBe(true);
  });

  test('settle follows the deployment until it is ready, and fails when its build fails', async () => {
    const wait = async (states, codes = ['200']) => {
      const runner = await temp();
      await writeFile(join(runner, 'datalogix-vercel-production'), 'dpl_1\n');
      return step('settle', {
        env: { ...VERCEL, RUNNER_TEMP: runner, SETTLE: '30' },
        curl: [{ match: 'v13/deployments/dpl_1', codes, bodies: states.map((readyState) => ({ readyState })) }],
      });
    };
    const ready = await wait(['BUILDING', 'BUILDING', 'READY']);
    expect(ready.code).toBe(0);
    expect(callsTo(ready, 'sleep')).toStrictEqual(['10', '10']);

    // A failed read is tried again
    expect((await wait(['BUILDING', 'READY'], ['500', '200'])).code).toBe(0);

    const failed = await wait(['BUILDING', 'ERROR']);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/ended as ERROR; the previous deployment is still live/);

    const slow = await wait(['BUILDING']);
    expect(slow.code).toBe(1);
    expect(slow.stdout).toMatch(/was not ready after 30 seconds \(BUILDING\)/);
  });
});

test('an unknown step fails', async () => {
  const result = await step('redeploy');
  expect(result.code).toBe(1);
  expect(result.stdout).toMatch(/::error::Unknown deploy step 'redeploy'/);
  expect(result.calls).toStrictEqual([]);
});

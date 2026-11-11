import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runScript } from './fakes.js';

const list = async (env) => {
  const dir = await mkdtemp(join(tmpdir(), 'plugins-'));
  try {
    const output = join(dir, 'output');
    const result = await runScript('plugins/plugins.sh', { env: { ...env, GITHUB_OUTPUT: output } });
    expect(result.code).toBe(0);
    return (await readFile(output, 'utf8')).split('\n').slice(1, -2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('always installs core and the plugin of the stack', async () => {
  expect(await list({ STACK: 'laravel' })).toStrictEqual(['core@datalogix', 'laravel@datalogix']);
  expect(await list({ STACK: 'js' })).toStrictEqual(['core@datalogix', 'js@datalogix']);
  expect(await list({ STACK: 'JS' })).toStrictEqual(['core@datalogix', 'js@datalogix']);
  expect(await list({ STACK: 'php' })).toStrictEqual(['core@datalogix', 'php@datalogix']);
  expect(await list({ STACK: 'PHP' })).toStrictEqual(['core@datalogix', 'php@datalogix']);
  expect(await list({ STACK: 'nuxt' })).toStrictEqual(['core@datalogix', 'laravel@datalogix']);
  expect(await list({})).toStrictEqual(['core@datalogix', 'laravel@datalogix']);
});

test('adds the plugins of the project without repeating one', async () => {
  expect(await list({ STACK: 'js', PLUGINS: 'laravel@datalogix\n' })).toStrictEqual([
    'core@datalogix',
    'js@datalogix',
    'laravel@datalogix',
  ]);
  expect(
    await list({ STACK: 'laravel', PLUGINS: '  laravel@datalogix\n\ncore@datalogix\nextra@market  \n' }),
  ).toStrictEqual(['core@datalogix', 'laravel@datalogix', 'extra@market']);
});

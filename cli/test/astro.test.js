import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import jsApp from '../stacks/js/app.js';
import { APP_STATE, fakeGitHub, folder, RELAY as relay } from './helpers.js';

// Quiet progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
}));

const site = (deps = {}) => JSON.stringify({ private: true, dependencies: { astro: '^5', ...deps } });

const answers = {
  repository: 'datalogix/app',
  deploy: 'vercel',
  staging: false,
  domain: 'example.com',
  monitoring: 'none',
  incidents: false,
  codeOwners: '@ana',
};
const stateOf = async (root) => ({ ...APP_STATE, stack: 'js', ...(await jsApp.inspect(root)) });
const taskOf = (state, root, extra, id) =>
  jsApp.setup
    .tasks({ ...answers, ...extra }, { github: fakeGitHub(), root, state, relay })
    .find((candidate) => candidate.id === id);

test('creates the Astro health endpoint, rendered on demand, when an adapter renders pages', async (t) => {
  const root = await folder(t, {
    'package.json': site({ '@astrojs/vercel': '^9' }),
    'astro.config.mjs': '',
    'tsconfig.json': '{}',
  });
  const state = await stateOf(root);
  expect(state).toMatchObject({
    framework: 'astro',
    astroAdapter: 'vercel',
    staticBuild: false,
    healthFile: 'src/pages/api/health.ts',
    healthRoute: false,
    spaFallback: null,
  });
  const step = jsApp.setup.steps().find((candidate) => candidate.id === 'healthRoute');
  expect(step.when({ deploy: 'vercel', healthPath: '/api/health' }, { state })).toBe(true);

  const file = 'src/pages/api/health.ts';
  expect(await taskOf(state, root, { healthPath: '/api/health', healthRoute: true }, `file:${file}`).run()).toBe(
    `created ${file}`,
  );
  const endpoint = await readFile(join(root, file), 'utf8');
  // Astro's endpoint, not Next's pages/api handler, which has the same file name
  expect(endpoint).toContain('export const prerender = false;');
  expect(endpoint).toContain("export const GET = () => Response.json({ status: 'ok' });");
  expect(endpoint).not.toContain('NextApiRequest');
  expect(endpoint).not.toContain('export default');
  expect(await stateOf(root)).toMatchObject({ healthRoute: true, healthFile: file });

  // In JavaScript without a tsconfig.json; an existing route in a folder is found
  const js = await stateOf(await folder(t, { 'package.json': site({ '@astrojs/netlify': '^6' }) }));
  expect(js.healthFile).toBe('src/pages/api/health.js');
  const index = await stateOf(
    await folder(t, { 'package.json': site({ '@astrojs/node': '^9' }), 'src/pages/api/health/index.ts': '' }),
  );
  expect(index).toMatchObject({ healthRoute: true, healthFile: 'src/pages/api/health/index.ts' });
});

test('gives an Astro site without an adapter the static health file, and no rewrite', async (t) => {
  const root = await folder(t, { 'package.json': site(), 'astro.config.mjs': '' });
  const state = await stateOf(root);
  expect(state).toMatchObject({
    framework: 'astro',
    astroAdapter: null,
    staticBuild: true,
    healthFile: 'public/health.json',
    spaFallback: null,
  });
  const step = jsApp.setup.steps().find((candidate) => candidate.id === 'healthRoute');
  expect(step.when({ deploy: 'vercel', healthPath: '/health.json' }, { state })).toBe(true);
  await taskOf(state, root, { healthPath: '/health.json', healthRoute: true }, 'file:public/health.json').run();
  expect(JSON.parse(await readFile(join(root, 'public/health.json'), 'utf8'))).toStrictEqual({ status: 'ok' });

  // One HTML file per page: no path is rewritten
  await taskOf(state, root, {}, 'file:vercel.json').run();
  expect(JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8')).rewrites).toBe(undefined);
  expect(taskOf(state, root, { deploy: 'netlify' }, 'file:netlify.toml')).toBe(undefined);
});

test("tells to install Sentry's Astro SDK with the Astro CLI", () => {
  const steps = jsApp.setup.nextSteps(
    { repository: 'datalogix/app', monitoring: 'sentry', incidents: true },
    { relay, results: [], state: { ...APP_STATE, stack: 'js', framework: 'astro', sentry: false } },
  );
  expect(steps).toContainEqual(expect.stringContaining('npx astro add @sentry/astro'));
  expect(steps).not.toContainEqual(expect.stringContaining('@sentry/wizard'));
});

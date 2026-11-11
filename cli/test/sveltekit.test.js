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

const KIT = JSON.stringify({
  private: true,
  devDependencies: { '@sveltejs/kit': '^2', '@sveltejs/adapter-auto': '^6', svelte: '^5', vite: '^7' },
});
const config = (adapter, options = '') =>
  `import adapter from '@sveltejs/adapter-${adapter}';\n\nexport default { kit: { adapter: adapter(${options}) } };\n`;

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

test('creates the SvelteKit health endpoint, not prerendered, and finds an existing one', async (t) => {
  const root = await folder(t, { 'package.json': KIT, 'svelte.config.js': config('auto'), 'tsconfig.json': '{}' });
  const state = await stateOf(root);
  expect(state).toMatchObject({
    framework: 'sveltekit',
    svelteAdapter: 'auto',
    staticBuild: false,
    healthFile: 'src/routes/api/health/+server.ts',
    healthRoute: false,
    spaFallback: null,
  });
  const step = jsApp.setup.steps().find((candidate) => candidate.id === 'healthRoute');
  expect(step.when({ deploy: 'vercel', healthPath: '/api/health' }, { state })).toBe(true);

  const file = 'src/routes/api/health/+server.ts';
  expect(await taskOf(state, root, { healthPath: '/api/health', healthRoute: true }, `file:${file}`).run()).toBe(
    `created ${file}`,
  );
  const endpoint = await readFile(join(root, file), 'utf8');
  expect(endpoint).toContain('export const prerender = false;');
  expect(endpoint).toContain("return Response.json({ status: 'ok' });");
  expect(await stateOf(root)).toMatchObject({ healthRoute: true, healthFile: file });

  // In JavaScript without a tsconfig.json
  const js = await stateOf(await folder(t, { 'package.json': KIT, 'svelte.config.js': config('vercel') }));
  expect(js.healthFile).toBe('src/routes/api/health/+server.js');
});

test('gives a SvelteKit app built with adapter-static the static health file in static/', async (t) => {
  const root = await folder(t, { 'package.json': KIT, 'svelte.config.js': config('static') });
  const state = await stateOf(root);
  expect(state).toMatchObject({ staticBuild: true, healthFile: 'static/health.json', spaFallback: null });
  const step = jsApp.setup.steps().find((candidate) => candidate.id === 'healthRoute');
  expect(step.when({ deploy: 'vercel', healthPath: '/health.json' }, { state })).toBe(true);
  await taskOf(state, root, { healthPath: '/health.json', healthRoute: true }, 'file:static/health.json').run();
  expect(JSON.parse(await readFile(join(root, 'static/health.json'), 'utf8'))).toStrictEqual({ status: 'ok' });

  // Prerendered pages only: no rewrite of the paths
  const vercel = taskOf(state, root, {}, 'file:vercel.json');
  await vercel.run();
  expect(JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8')).rewrites).toBe(undefined);
});

test("rewrites every path of a SvelteKit single-page app to adapter-static's fallback page", async (t) => {
  const root = await folder(t, {
    'package.json': KIT,
    'svelte.config.js': config('static', "{ fallback: '200.html' }"),
  });
  const state = await stateOf(root);
  expect(state).toMatchObject({ staticBuild: true, spaFallback: '/200.html' });

  expect(await taskOf(state, root, {}, 'file:vercel.json').run()).toContain('every path rewritten to 200.html');
  expect(JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8')).rewrites).toStrictEqual([
    { source: '/(.*)', destination: '/200.html' },
  ]);

  const netlify = taskOf(state, root, { deploy: 'netlify' }, 'file:netlify.toml');
  expect(await netlify.run()).toBe('created: every path redirected to 200.html');
  expect(await readFile(join(root, 'netlify.toml'), 'utf8')).toContain('to = "/200.html"');
});

test('takes a Svelte app built with Vite as a single-page app', async (t) => {
  const manifest = JSON.stringify({ private: true, dependencies: { svelte: '^5' }, devDependencies: { vite: '^7' } });
  const state = await stateOf(await folder(t, { 'package.json': manifest, 'index.html': '' }));
  expect(state).toMatchObject({ framework: 'svelte', healthFile: 'public/health.json', spaFallback: null });
});

test("tells to install Sentry's SvelteKit SDK with its wizard, and Svelte's with npm", () => {
  const next = (framework) =>
    jsApp.setup.nextSteps(
      { repository: 'datalogix/app', monitoring: 'sentry', incidents: true },
      { relay, results: [], state: { ...APP_STATE, stack: 'js', framework, sentry: false } },
    );
  expect(next('sveltekit')).toContainEqual(expect.stringContaining('npx @sentry/wizard@latest -i sveltekit'));
  expect(next('svelte')).toContainEqual(expect.stringContaining('npm install @sentry/svelte'));
});

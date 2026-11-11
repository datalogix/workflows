import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import jsApp, { registerHealthRoute } from '../stacks/js/app.js';
import { APP_STATE, fakeGitHub, folder, RELAY as relay } from './helpers.js';

// Quiet progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
}));

const routerApp = (deps = {}) =>
  JSON.stringify({
    private: true,
    dependencies: { react: '^19', 'react-router': '^7', ...deps },
    devDependencies: { '@react-router/dev': '^7' },
  });
const remixApp = (deps = {}) =>
  JSON.stringify({
    private: true,
    dependencies: { react: '^18', '@remix-run/react': '^2', ...deps },
    devDependencies: { '@remix-run/dev': '^2' },
  });

// The routes.ts of React Router's template
const ROUTES = `import { type RouteConfig, index } from "@react-router/dev/routes";

export default [index("routes/home.tsx")] satisfies RouteConfig;
`;

const answers = {
  repository: 'datalogix/app',
  deploy: 'vercel',
  staging: false,
  domain: 'example.com',
  monitoring: 'none',
  incidents: false,
  codeOwners: '@ana',
  healthPath: '/api/health',
};
const stateOf = async (root) => ({ ...APP_STATE, stack: 'js', ...(await jsApp.inspect(root)) });
const tasksOf = (state, root, extra = {}) =>
  jsApp.setup.tasks({ ...answers, ...extra }, { github: fakeGitHub(), root, state, relay });
const taskOf = (state, root, extra, id) => tasksOf(state, root, extra).find((candidate) => candidate.id === id);

test('creates the React Router health resource route and registers it in app/routes.ts', async (t) => {
  const root = await folder(t, { 'package.json': routerApp(), 'tsconfig.json': '{}', 'app/routes.ts': ROUTES });
  const state = await stateOf(root);
  expect(state).toMatchObject({
    framework: 'react-router',
    appDirectory: 'app',
    staticBuild: false,
    healthFile: 'app/routes/api.health.ts',
    healthRoute: false,
    routesFile: 'app/routes.ts',
    routesRegistration: 'insert',
  });
  const step = jsApp.setup.steps().find((candidate) => candidate.id === 'healthRoute');
  expect(step.when({ deploy: 'vercel', healthPath: '/api/health' }, { state })).toBe(true);

  const file = 'app/routes/api.health.ts';
  expect(await taskOf(state, root, { healthRoute: true }, `file:${file}`).run()).toBe(`created ${file}`);
  const route = await readFile(join(root, file), 'utf8');
  // A resource route: a loader and no component, not Next's handler
  expect(route).toContain('export function loader()');
  expect(route).toContain("return Response.json({ status: 'ok' });");
  expect(route).not.toContain('export default');

  expect(await taskOf(state, root, { healthRoute: true }, 'file:app/routes.ts').run()).toBe(
    `updated: route api/health → ${file}`,
  );
  expect(await readFile(join(root, 'app/routes.ts'), 'utf8'))
    .toBe(`import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [index("routes/home.tsx"), route("api/health", "routes/api.health.ts")] satisfies RouteConfig;
`);
  // Registered and present: nothing left to do
  expect(await stateOf(root)).toMatchObject({ healthRoute: true, routesRegistration: 'registered' });
  expect(await taskOf(state, root, { healthRoute: true }, 'file:app/routes.ts').run()).toBe('unchanged');
});

test('adds the entry to a routes array on several lines, keeping route already imported', () => {
  const routes = `import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('about', 'routes/about.tsx')
] satisfies RouteConfig;
`;
  expect(registerHealthRoute(routes, 'app/routes/api.health.js', 'app'))
    .toBe(`import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('about', 'routes/about.tsx'),
  route('api/health', 'routes/api.health.js'),
] satisfies RouteConfig;
`);
});

test('leaves app/routes.ts alone with flatRoutes(), and asks to register the route when it cannot add it', async (t) => {
  const flat = `import { type RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

export default flatRoutes() satisfies RouteConfig;
`;
  const root = await folder(t, { 'package.json': routerApp(), 'app/routes.ts': flat });
  const state = await stateOf(root);
  expect(state).toMatchObject({ routesRegistration: 'flat', healthFile: 'app/routes/api.health.js' });
  expect(tasksOf(state, root, { healthRoute: true }).map((task) => task.id)).not.toContain('file:app/routes.ts');

  // A routes.ts setup cannot edit safely (two arrays): a next step instead
  const odd = `import { type RouteConfig, index } from "@react-router/dev/routes";
const admin = [index("routes/admin.tsx")] satisfies RouteConfig;
export default [index("routes/home.tsx"), ...admin] satisfies RouteConfig;
`;
  const manual = await stateOf(await folder(t, { 'package.json': routerApp(), 'app/routes.ts': odd }));
  expect(manual.routesRegistration).toBe('manual');
  expect(tasksOf(manual, root, { healthRoute: true }).map((task) => task.id)).not.toContain('file:app/routes.ts');
  const steps = jsApp.setup.nextSteps({ ...answers, healthRoute: true }, { relay, results: [], state: manual });
  expect(steps).toContainEqual(expect.stringContaining("route('api/health', 'routes/api.health.js')"));

  // A route file that exists but is not registered is not taken as the health route, and is kept
  const unregistered = await folder(t, {
    'package.json': routerApp(),
    'app/routes.ts': ROUTES,
    'app/routes/api.health.ts': '// mine\n',
  });
  const kept = await stateOf(unregistered);
  expect(kept).toMatchObject({ healthRoute: false, healthFile: 'app/routes/api.health.ts' });
  expect(await taskOf(kept, unregistered, { healthRoute: true }, 'file:app/routes/api.health.ts').run()).toBe(
    'unchanged',
  );
  expect(await readFile(join(unregistered, 'app/routes/api.health.ts'), 'utf8')).toBe('// mine\n');
});

test('reads the app directory of react-router.config, and finds a route folder', async (t) => {
  const root = await folder(t, {
    'package.json': routerApp(),
    'react-router.config.ts': "export default { appDirectory: 'src/app' } satisfies Config;",
    'src/app/routes.ts': ROUTES,
    'src/app/routes/api.health/route.tsx': '',
  });
  const state = await stateOf(root);
  expect(state).toMatchObject({ appDirectory: 'src/app', routesFile: 'src/app/routes.ts' });
  // Present but not registered in routes.ts
  expect(state).toMatchObject({ healthFile: 'src/app/routes/api.health/route.tsx', healthRoute: false });
});

test('gives a React Router single-page app (ssr: false) the static health file and the rewrite to index.html', async (t) => {
  const root = await folder(t, {
    'package.json': routerApp(),
    'react-router.config.ts': 'export default { ssr: false } satisfies Config;',
    'app/routes.ts': ROUTES,
  });
  const state = await stateOf(root);
  expect(state).toMatchObject({
    framework: 'react-router',
    staticBuild: true,
    healthFile: 'public/health.json',
    spaFallback: '/index.html',
  });
  const extra = { healthPath: '/health.json', healthRoute: true };
  const ids = tasksOf(state, root, extra).map((task) => task.id);
  expect(ids).toContain('file:public/health.json');
  expect(ids).not.toContain('file:app/routes.ts');
  expect(await taskOf(state, root, extra, 'file:vercel.json').run()).toContain('every path rewritten to index.html');
  expect(JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8')).rewrites).toStrictEqual([
    { source: '/(.*)', destination: '/index.html' },
  ]);
});

test('creates the Remix health route as a flat route, with no registration', async (t) => {
  const root = await folder(t, { 'package.json': remixApp(), 'tsconfig.json': '{}', 'vite.config.ts': 'remix()' });
  const state = await stateOf(root);
  expect(state).toMatchObject({
    framework: 'remix',
    healthFile: 'app/routes/api.health.ts',
    routesRegistration: null,
    staticBuild: false,
  });
  const file = 'app/routes/api.health.ts';
  const ids = tasksOf(state, root, { healthRoute: true }).map((task) => task.id);
  expect(ids).toContain(`file:${file}`);
  expect(ids.filter((id) => id?.endsWith('routes.ts'))).toStrictEqual([]);
  await taskOf(state, root, { healthRoute: true }, `file:${file}`).run();
  expect(await readFile(join(root, file), 'utf8')).toContain('export function loader()');
  expect((await stateOf(root)).healthRoute).toBe(true);

  // SPA mode of the Vite plugin
  const spa = await stateOf(await folder(t, { 'package.json': remixApp(), 'vite.config.ts': 'remix({ ssr: false })' }));
  expect(spa).toMatchObject({ staticBuild: true, healthFile: 'public/health.json', spaFallback: '/index.html' });
});

test("tells to install Sentry's SDK with the wizard of React Router or Remix", async (t) => {
  const next = async (manifest) =>
    jsApp.setup.nextSteps(
      { ...answers, deploy: 'none', monitoring: 'sentry', incidents: true },
      { relay, results: [], state: await stateOf(await folder(t, { 'package.json': manifest })) },
    );
  expect(await next(routerApp())).toContainEqual(expect.stringContaining('npx @sentry/wizard@latest -i reactRouter'));
  expect(await next(remixApp())).toContainEqual(expect.stringContaining('npx @sentry/wizard@latest -i remix'));
  // Installed: nothing to say
  expect(await next(routerApp({ '@sentry/react-router': '^10' }))).not.toContainEqual(
    expect.stringContaining('@sentry/wizard'),
  );
});

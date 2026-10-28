import { beforeEach, expect, test, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { issueForms, org, relayTokenUrl } from '../commands/org.js';
import { cloudflareLoggedIn, cloudflareLogin, deployRelay, relayNamespace } from '../kinds/project/relay.js';
import { onPlatform, RELAY } from './helpers.js';

// Quiet, and answers the questions as each test says
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  spinner: () => ({ start() {}, stop() {}, error() {}, message() {} }),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), message: vi.fn() },
  note: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
}));

// Cloudflare is replaced: the tests read what org asked of it
vi.mock('../kinds/project/relay.js', async (importOriginal) => ({
  ...(await importOriginal()),
  cloudflareLoggedIn: vi.fn(),
  cloudflareLogin: vi.fn(),
  relayNamespace: vi.fn(),
  deployRelay: vi.fn(),
}));

const WORKER_URL = 'https://incident-relay.datalogix.workers.dev';

beforeEach((t) => {
  vi.clearAllMocks();
  onPlatform(t, 'linux');
  cloudflareLoggedIn.mockResolvedValue(true);
  cloudflareLogin.mockResolvedValue(true);
  relayNamespace.mockResolvedValue({ id: 'a'.repeat(32), created: true });
  deployRelay.mockResolvedValue(WORKER_URL);
  clack.confirm.mockResolvedValue(true);
  clack.password.mockResolvedValue('github_pat_abc');
});

/** An organization with those apps, plan and files of its .github repository (null: no repository), recording writes. */
function fakeOrganization({ apps = ['claude'], plan = 'free', files = null } = {}) {
  const calls = [];
  let stored = files && { ...files };
  return {
    organization: 'datalogix',
    calls,
    plan: async () => plan,
    installedApps: async () => apps,
    repo: async () => (stored ? { name: '.github' } : null),
    file: async (name, path) => (stored?.[path] === undefined ? null : { sha: `sha-${path}`, content: stored[path] }),
    createPublicRepo: async (name) => {
      calls.push(['repo', name]);
      stored = {};
    },
    putFile: async (name, path, content, message, sha) => {
      calls.push(['file', path, sha ?? null]);
      stored[path] = content;
    },
  };
}

const run = (organization, { flags = {}, relay } = {}) =>
  org({ repository: 'datalogix/app', flags, relay, createOrganization: () => organization });

const formPaths = async () => Object.keys(await issueForms()).map((file) => `.github/ISSUE_TEMPLATE/${file}`);
const leftByHand = () => clack.note.mock.calls.at(-1)[0];

test('creates the .github repository with the issue forms and deploys the relay', async () => {
  const organization = fakeOrganization();
  expect(await run(organization)).toBe(0);

  const relayFile = 'workflows/relay.json';
  expect(organization.calls).toStrictEqual([
    ['repo', '.github'],
    ...(await formPaths()).map((path) => ['file', path, null]),
    ['file', relayFile, null],
  ]);
  expect(deployRelay).toHaveBeenCalledWith({
    namespaceId: 'a'.repeat(32),
    owner: 'datalogix',
    token: 'github_pat_abc',
  });
  expect(JSON.parse((await organization.file('.github', relayFile)).content)).toStrictEqual({
    url: WORKER_URL,
    namespaceId: 'a'.repeat(32),
    owner: 'datalogix',
  });
  // Already logged in to Cloudflare
  expect(cloudflareLogin).not.toHaveBeenCalled();
  // GitHub Free: the Claude token goes in each project
  expect(leftByHand()).toContain('setup asks for it in each project');
});

test('changes only the forms that differ and keeps the relay unless asked to update it', async () => {
  const [first, second] = await formPaths();
  const forms = Object.values(await issueForms());
  const organization = fakeOrganization({
    files: { [first]: forms[0], [second]: 'old', 'workflows/relay.json': '{}' },
    plan: 'team',
  });
  clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await run(organization, { relay: RELAY })).toBe(0);

  expect(organization.calls).toStrictEqual([['file', second, `sha-${second}`]]);
  expect(deployRelay).not.toHaveBeenCalled();
  expect(clack.password).not.toHaveBeenCalled();
  expect(leftByHand()).toContain('gh secret set CLAUDE_CODE_OAUTH_TOKEN --org datalogix --visibility all');
});

test('updates the relay in its namespace, keeping its token when none is given', async () => {
  const organization = fakeOrganization({ files: {} });
  clack.password.mockResolvedValue('');
  expect(await run(organization, { relay: RELAY })).toBe(0);
  expect(relayNamespace).not.toHaveBeenCalled();
  expect(deployRelay).toHaveBeenCalledWith({ namespaceId: 'id', owner: 'datalogix', token: '' });
});

test('skips the relay when no token is given, and logs in to Cloudflare only to deploy it', async () => {
  clack.password.mockResolvedValue('');
  cloudflareLoggedIn.mockResolvedValue(false);
  expect(await run(fakeOrganization({ files: {} }))).toBe(0);
  expect(deployRelay).not.toHaveBeenCalled();
  expect(cloudflareLoggedIn).not.toHaveBeenCalled();
  expect(leftByHand()).toContain('until the relay is deployed');

  clack.password.mockResolvedValue('github_pat_abc');
  expect(await run(fakeOrganization({ files: {} }))).toBe(0);
  expect(cloudflareLogin).toHaveBeenCalledOnce();
});

test('tells how to see or install the Claude GitHub App', async () => {
  clack.password.mockResolvedValue('');
  await run(fakeOrganization({ apps: null, files: {} }));
  expect(clack.log.warn).toHaveBeenCalledWith(expect.stringContaining('gh auth refresh -s admin:org'));
  expect(leftByHand()).toContain('https://github.com/apps/claude/installations/new');

  await run(fakeOrganization({ apps: ['codecov'], files: {} }));
  expect(clack.log.error).toHaveBeenCalledWith('The Claude GitHub App is not installed');
});

test('changes nothing when the changes are not confirmed', async () => {
  const organization = fakeOrganization();
  clack.confirm.mockResolvedValue(false);
  expect(await run(organization)).toBe(1);
  expect(organization.calls).toStrictEqual([]);
  expect(deployRelay).not.toHaveBeenCalled();
});

test('takes the organization from --org, else from the git remote', async () => {
  clack.password.mockResolvedValue('');
  const asked = [];
  const createOrganization = (name) => (asked.push(name), fakeOrganization({ files: {} }));
  await org({ repository: null, flags: { org: 'other' }, createOrganization });
  await org({ repository: 'datalogix/app', flags: {}, createOrganization });
  expect(asked).toStrictEqual(['other', 'datalogix']);
  await expect(org({ repository: null, flags: {}, createOrganization })).rejects.toThrow('--org');
});

test('does not deploy the relay on Windows', async (t) => {
  onPlatform(t, 'win32');
  expect(await run(fakeOrganization({ files: {} }))).toBe(0);
  expect(clack.password).not.toHaveBeenCalled();
  expect(leftByHand()).toContain('macOS or Linux');
});

test('links to a fine-grained token filled in for the relay', () => {
  const url = new URL(relayTokenUrl('datalogix'));
  expect(url.pathname).toBe('/settings/personal-access-tokens/new');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    name: 'datalogix incident relay',
    target_name: 'datalogix',
    contents: 'write',
    expires_in: '366',
  });
});

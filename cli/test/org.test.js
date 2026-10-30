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

/**
 * An organization with those apps, plan and files of its .github repository (null: no repository), recording writes.
 * `details` null is a user (or an organization gh cannot see); `role` is the gh login's.
 */
function fakeOrganization({
  apps = ['claude'],
  plan = 'free',
  files = null,
  isPrivate = false,
  details = { login: 'datalogix', plan: { name: plan } },
  role = 'admin',
} = {}) {
  const calls = [];
  let stored = files && { ...files };
  return {
    organization: 'datalogix',
    calls,
    details: async () => details,
    role: async () => role,
    installedApps: async () => apps,
    repo: async () => (stored ? { name: '.github', private: isPrivate } : null),
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

const run = (organization, { flags = {} } = {}) =>
  org({ repository: 'datalogix/app', flags, createOrganization: () => organization });

/** relay.json as the org command writes it. */
const relayJson = (relay) =>
  `${JSON.stringify({ url: relay.url, namespaceId: relay.namespaceId, owner: relay.owner }, null, 2)}\n`;

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
    worker: 'incident-relay-datalogix',
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
    files: { [first]: forms[0], [second]: 'old', 'workflows/relay.json': relayJson(RELAY) },
    plan: 'team',
  });
  clack.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await run(organization)).toBe(0);

  expect(organization.calls).toStrictEqual([['file', second, `sha-${second}`]]);
  expect(deployRelay).not.toHaveBeenCalled();
  expect(clack.password).not.toHaveBeenCalled();
  expect(leftByHand()).toContain('gh secret set CLAUDE_CODE_OAUTH_TOKEN --org datalogix --visibility all');
});

test('updates the relay in its namespace, keeping its token when none is given', async () => {
  const relay = { ...RELAY, url: 'https://incident-relay.datalogix.workers.dev' };
  // Written before relay.json had the owner: the update adds it
  const organization = fakeOrganization({
    files: { 'workflows/relay.json': JSON.stringify({ url: relay.url, namespaceId: relay.namespaceId }) },
  });
  clack.password.mockResolvedValue('');
  expect(await run(organization)).toBe(0);
  expect(relayNamespace).not.toHaveBeenCalled();
  // The worker deployed before, so the webhooks keep their URL
  expect(deployRelay).toHaveBeenCalledWith({
    namespaceId: 'id',
    owner: 'datalogix',
    token: '',
    worker: 'incident-relay',
  });
  // relay.json read once, its sha used for the update
  expect(organization.calls).toContainEqual(['file', 'workflows/relay.json', 'sha-workflows/relay.json']);
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

  // A relay already deployed is there: only updating it takes another system
  expect(await run(fakeOrganization({ files: { 'workflows/relay.json': relayJson(RELAY) } }))).toBe(0);
  expect(clack.log.success).toHaveBeenCalledWith(
    'Monitoring relay at https://relay.test (updating it takes macOS or Linux)',
  );
  expect(leftByHand()).not.toContain('to deploy the monitoring relay');
});

test('stops before asking anything for a user or an organization the gh login does not administer', async () => {
  const user = fakeOrganization({ details: null });
  await expect(run(user)).rejects.toThrow('datalogix is not an organization, or your gh login cannot see it');
  const member = fakeOrganization({ role: 'member' });
  await expect(run(member)).rejects.toThrow('org takes an admin of datalogix, and your gh login is a member');
  await expect(run(fakeOrganization({ role: null }))).rejects.toThrow('your gh login is not a member');
  expect(clack.password).not.toHaveBeenCalled();
  expect(clack.confirm).not.toHaveBeenCalled();
  expect([...user.calls, ...member.calls]).toStrictEqual([]);
});

test('tells to make a private .github repository public, as GitHub uses only public issue forms', async () => {
  clack.password.mockResolvedValue('');
  expect(await run(fakeOrganization({ files: {}, isPrivate: true }))).toBe(0);
  expect(clack.log.warn).toHaveBeenCalledWith('datalogix/.github is private, so its issue forms reach no repository');
  expect(leftByHand()).toContain('public in its settings');

  await run(fakeOrganization({ files: {} }));
  expect(leftByHand()).not.toContain('public in its settings');
});

test('goes on without the relay when the Cloudflare login fails', async () => {
  cloudflareLoggedIn.mockResolvedValue(false);
  cloudflareLogin.mockResolvedValue(false);
  const organization = fakeOrganization();
  expect(await run(organization)).toBe(1);
  expect(deployRelay).not.toHaveBeenCalled();
  // The repository and the forms do not need Cloudflare
  expect(organization.calls[0]).toStrictEqual(['repo', '.github']);
  expect(organization.calls.length).toBeGreaterThan(1);
  expect(leftByHand()).toContain('npx wrangler login');
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

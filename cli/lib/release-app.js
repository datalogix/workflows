import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { clack, dim, orExit, question } from './ui.js';

// The GitHub App that opens release pull requests, shared by apps (release pull requests from the development branch
// to the production branch, cli/kinds/project) and packages (the release pull request of package-release.yml,
// cli/kinds/package): its secrets, whether the repository can read them, and the questions and task that store them.
// Pull requests opened with the workflow token run no workflows, so their checks never report.

// Secrets of the release GitHub App
export const RELEASE_APP_SECRETS = ['RELEASE_APP_CLIENT_ID', 'RELEASE_APP_PRIVATE_KEY'];

/**
 * Whether the repository can read both secrets of the release GitHub App, as repository or organization secrets.
 * Without them the release pull requests are opened with the workflow token, so their checks do not run.
 */
export async function hasReleaseApp(github) {
  const found = await Promise.all(
    RELEASE_APP_SECRETS.map(async (name) => {
      const [repository, organization] = await Promise.all([
        github.hasRepositorySecret(name),
        github.hasOrganizationSecret(name).catch(() => false),
      ]);
      return repository || organization;
    }),
  );
  return found.every(Boolean);
}

// The App's private key file, as GitHub downloads it; ~ is the home folder
const keyPath = (value) => resolve(value.trim().replace(/^~(?=$|\/)/, homedir()));
export const readKey = (value) => readFileSync(keyPath(value), 'utf8');
export const validKey = (value) => {
  try {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readKey(value ?? ''))
      ? undefined
      : 'Not a private key (.pem) file';
  } catch {
    return 'Cannot read that file';
  }
};

/**
 * The Client ID and private key questions of the release GitHub App, asked when `needed(answers, ctx)` and the
 * repository cannot read its secrets; `without` says what happens with an empty Client ID.
 */
export function releaseAppSteps({ needed, without }) {
  return [
    {
      id: 'releaseAppClientId',
      // Organization secrets reach private repositories only on paid plans: elsewhere, the repository stores its own
      when: (a, ctx) => needed(a, ctx) && !ctx.state.releaseApp,
      ask: async ({ header }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              `Client ID of the release GitHub App${dim('  optional; empty to add it later')}`,
              without,
            ),
            placeholder: 'Iv23li...',
          }),
        ),
    },
    {
      id: 'releaseAppKey',
      validate: validKey,
      when: (a, ctx) => needed(a, ctx) && !ctx.state.releaseApp && Boolean(a.releaseAppClientId?.trim()),
      ask: async ({ header }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              `Private key file of the release GitHub App${dim('  the .pem GitHub downloaded')}`,
            ),
            placeholder: '~/Downloads/app.private-key.pem',
            validate: validKey,
          }),
        ),
    },
  ];
}

/** Whether the answers give both the Client ID and the key file of the release GitHub App. */
export const answersReleaseApp = (answers) => Boolean(answers.releaseAppClientId?.trim() && answers.releaseAppKey);

/** Stores the secrets of the release GitHub App; `stored()` runs once they are. */
export function releaseAppTask(answers, github, stored = () => {}) {
  return {
    id: 'releaseApp',
    title: 'Release GitHub App',
    run: async () => {
      // Read when applying, so the key never stays in the answers; sent on stdin like every secret
      await github.setSecret('RELEASE_APP_CLIENT_ID', answers.releaseAppClientId.trim());
      await github.setSecret('RELEASE_APP_PRIVATE_KEY', readKey(answers.releaseAppKey));
      stored();
      return 'stored as repository secrets';
    },
  };
}

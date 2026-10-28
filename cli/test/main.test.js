import { beforeEach, expect, test, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { check } from '../commands/check.js';
import { main } from '../lib/main.js';
import { detectProject } from '../lib/project.js';
import { run } from '../lib/shell.js';

// gh, the project folder and the commands are replaced: main only parses, checks gh and dispatches
vi.mock('../lib/shell.js', () => ({ run: vi.fn(), runOrThrow: vi.fn() }));
vi.mock('../lib/project.js', async (importOriginal) => ({ ...(await importOriginal()), detectProject: vi.fn() }));
vi.mock('../commands/check.js', () => ({ check: vi.fn(async () => 0) }));
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  intro: vi.fn(),
  cancel: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  detectProject.mockResolvedValue({ root: '/project', repository: 'datalogix/app' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

test('prints the help and exits with 0', async () => {
  expect(await main(['help'])).toBe(0);
  expect(await main(['check', '--help'])).toBe(0);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage: npx github:datalogix/workflows#v2'));
});

test('exits with 2 on bad arguments or an unknown command', async () => {
  expect(await main(['--deplo', 'forge'])).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Unknown option: --deplo\n/));
  expect(await main(['deploy'])).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Unknown command: deploy\n/));
});

test('exits with 1 without the GitHub CLI or its login', async () => {
  run.mockResolvedValueOnce({ code: 127, stdout: '', stderr: '' });
  expect(await main(['check'])).toBe(1);
  expect(clack.cancel).toHaveBeenCalledWith(expect.stringContaining('The GitHub CLI is not installed'));
  run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'not logged in' });
  expect(await main(['check'])).toBe(1);
  expect(clack.cancel).toHaveBeenCalledWith(expect.stringContaining('Log in to GitHub first'));
  expect(check).not.toHaveBeenCalled();
});

test('needs a repository for check and protect, from the folder or --repo', async () => {
  detectProject.mockResolvedValue({ root: '/project', repository: null });
  expect(await main(['check'])).toBe(1);
  expect(clack.cancel).toHaveBeenCalledWith('Run it from the project folder, or pass --repo owner/repo');

  expect(await main(['check', '--repo', 'datalogix/other'])).toBe(0);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({ root: '/project', repository: 'datalogix/other', folderRepository: null }),
  );
});

test('shows the error of a command that fails and exits with 1', async () => {
  check.mockRejectedValueOnce(new Error('Cannot read the labels of datalogix/app: HTTP 403'));
  expect(await main(['check'])).toBe(1);
  expect(clack.cancel).toHaveBeenCalledWith('Cannot read the labels of datalogix/app: HTTP 403');
});

test('returns the exit code of the command', async () => {
  check.mockResolvedValueOnce(1);
  expect(await main(['check'])).toBe(1);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({ repository: 'datalogix/app', folderRepository: 'datalogix/app' }),
  );
});

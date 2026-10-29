import { expect, test } from 'vitest';
import { parseRemote } from '../lib/project.js';

test('reads owner/repo from git remotes', () => {
  expect(parseRemote('git@github.com:datalogix/app.git')).toBe('datalogix/app');
  expect(parseRemote('https://github.com/datalogix/app.git\n')).toBe('datalogix/app');
  expect(parseRemote('https://github.com/datalogix/my.app')).toBe('datalogix/my.app');
  expect(parseRemote('ssh://git@github.com/datalogix/app')).toBe('datalogix/app');
  expect(parseRemote('https://gitlab.com/datalogix/app.git')).toBe(null);
});

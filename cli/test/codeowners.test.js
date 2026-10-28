import { expect, test } from 'vitest';
import { isOwnerList, parseOwners, renderCodeOwners } from '../lib/codeowners.js';

test('creates the file with the owners of .github', () => {
  const content = renderCodeOwners('@ana  @datalogix/devs');
  expect(content).toMatch(/^# .*\n\/\.github\/ @ana @datalogix\/devs\n$/);
  expect(parseOwners(content)).toStrictEqual(['@ana', '@datalogix/devs']);
});

test('keeps the other lines and adds .github last, so it wins over broader patterns', () => {
  const content = renderCodeOwners('@ana', '* @bruno\n/app/Billing/ @carla\n');
  expect(content).toMatch(/^\* @bruno\n\/app\/Billing\/ @carla\n\n# .*\n\/\.github\/ @ana\n$/);
});

test('replaces only its own line', () => {
  const existing = '* @bruno\n/.github/ @old\n/docs/ @carla\n';
  expect(renderCodeOwners('@ana', existing)).toBe('* @bruno\n/.github/ @ana\n/docs/ @carla\n');
  expect(renderCodeOwners('@ana', renderCodeOwners('@ana', existing))).toBe(renderCodeOwners('@ana', existing));
});

test('reads and replaces the last .github line, the one GitHub applies', () => {
  const existing = '/.github/ @old\n* @bruno\n/.github/ @current\n';
  expect(parseOwners(existing)).toStrictEqual(['@current']);
  expect(renderCodeOwners('@ana', existing)).toBe('/.github/ @old\n* @bruno\n/.github/ @ana\n');
});

test('reads no owners when the file does not cover .github', () => {
  expect(parseOwners('* @bruno\n')).toBe(null);
  expect(parseOwners('/.github/\n')).toBe(null);
});

test('accepts users, teams and emails', () => {
  expect(isOwnerList('@ana @datalogix/devs ana@example.com')).toBe(true);
  expect(isOwnerList('')).toBe(false);
  expect(isOwnerList('ana')).toBe(false);
  expect(isOwnerList('@ana, @bruno')).toBe(false);
});

test('ignores a comment at the end of the line', () => {
  expect(parseOwners('/.github/ @ana # owners\n')).toStrictEqual(['@ana']);
});

test('reads the last line after the .github one that covers it, as GitHub applies it', () => {
  expect(parseOwners('/.github/ @ana\n* @bruno\n')).toStrictEqual(['@bruno']);
  expect(parseOwners('/.github/ @ana\n/.github/workflows/ @bruno\n')).toStrictEqual(['@bruno']);
  expect(parseOwners('/.github/ @ana\ndocs/ @bruno\n')).toStrictEqual(['@ana']);
  // A covering line without owners takes them away
  expect(parseOwners('/.github/ @ana\n*\n')).toBe(null);
});

test('moves the .github line last when a broader line after it would win', () => {
  expect(renderCodeOwners('@carla', '/.github/ @ana\n* @bruno\n')).toBe(
    '* @bruno\n\n# Changes to the workflows need their approval, so a pull request cannot lower its own checks (datalogix/workflows)\n/.github/ @carla\n',
  );
});

test('keeps the CRLF line ends of the file', () => {
  expect(renderCodeOwners('@carla', '* @bruno\r\n/.github/ @ana\r\n')).toBe('* @bruno\r\n/.github/ @carla\r\n');
});

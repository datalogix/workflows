import { expect, test } from 'vitest';
import { coverageItems, minCoverageOf, writesClover } from '../lib/coverage.js';
import { createReport } from '../lib/evaluate.js';
import { folder } from './helpers.js';

test('finds a Clover report in the configuration of PHPUnit, Vitest, Jest or package.json', async (t) => {
  const writes = async (files) => writesClover(await folder(t, files));

  expect(await writes({ 'phpunit.xml.dist': '<clover outputFile="clover.xml"/>' })).toBe(true);
  expect(await writes({ 'phpunit.dist.xml': '<clover outputFile="build/logs/clover.xml"/>' })).toBe(true);
  expect(await writes({ 'vitest.config.ts': "coverage: { reporter: ['text', 'clover'] }" })).toBe(true);
  expect(await writes({ 'vite.config.mjs': "test: { coverage: { reporter: ['clover'] } }" })).toBe(true);
  expect(await writes({ 'jest.config.cjs': "coverageReporters: ['clover']" })).toBe(true);
  expect(await writes({ 'package.json': '{"scripts":{"test":"vitest run --coverage.reporter=clover"}}' })).toBe(true);

  expect(await writes({ 'phpunit.xml': '<phpunit/>', 'package.json': '{}' })).toBe(false);
  // Only the configuration files count
  expect(await writes({ 'README.md': 'clover', 'src/clover.php': '' })).toBe(false);
  expect(await writesClover('/nonexistent/folder')).toBe(false);
});

test('reads the minimum coverage, 100 by default', () => {
  expect(minCoverageOf({})).toBe(100);
  expect(minCoverageOf(null)).toBe(100);
  expect(minCoverageOf({ minCoverage: '80' })).toBe(80);
  expect(minCoverageOf({ minCoverage: '0' })).toBe(0);
  expect(minCoverageOf({ minCoverage: '${{ vars.MIN }}' })).toBe(null);
});

test('reports the Clover report only when the tests check a minimum coverage', () => {
  const items = (state) => {
    const report = createReport();
    coverageItems(report, state);
    return report.items.map(({ level, title }) => [level, title]);
  };

  expect(items({ current: {}, clover: true })).toStrictEqual([['ok', 'Clover report for the minimum coverage (100%)']]);
  expect(items({ current: { minCoverage: '90' }, clover: false })).toStrictEqual([
    ['warn', 'No Clover report configured, so the minimum coverage (90%) fails the tests'],
  ]);
  // An expression is shown as written
  expect(items({ current: { minCoverage: '${{ vars.MIN }}' }, clover: false })[0][1]).toContain('(${{ vars.MIN }}%)');

  // Off, or the folder not read
  expect(items({ current: { minCoverage: '0' }, clover: false })).toStrictEqual([]);
  expect(items({ current: { tests: false }, clover: false })).toStrictEqual([]);
  expect(items({ current: { testCommand: 'none' }, clover: false })).toStrictEqual([]);
  expect(items({ current: {}, clover: null })).toStrictEqual([]);
  expect(items({ current: null, clover: false })).toStrictEqual([]);
});

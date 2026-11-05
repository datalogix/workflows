import { expect, test } from 'vitest';
import { createReport, rulesetItems } from '../lib/evaluate.js';
import { rulesetBody } from '../lib/ruleset.js';

const titles = (items, level) => items.filter((item) => item.level === level).map((item) => item.title);

test('reports a required check whose layer is off, and ignores checks it does not know', () => {
  const report = createReport();
  rulesetItems(
    report,
    { canProtect: true, ruleset: rulesetBody(['pipeline / gate / gate', 'old']) },
    {
      expected: [],
      known: ['pipeline / gate / gate'],
    },
  );
  expect(titles(report.items, 'error')).toStrictEqual([
    'The ruleset requires pipeline / gate / gate, but that layer is off: every pull request waits for it',
  ]);
});

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const root = join(import.meta.dirname, '../../..');

// The YAML files whose ${{ }} expressions GitHub evaluates: workflows, actions and the examples projects copy
async function yamlFiles() {
  const files = [];
  for (const dir of ['.github/workflows', 'examples']) {
    for (const name of await readdir(join(root, dir))) if (name.endsWith('.yml')) files.push(join(root, dir, name));
  }
  for (const name of await readdir(join(root, '.github/actions'))) {
    const action = join(root, '.github/actions', name, 'action.yml');
    if (await readFile(action).catch(() => null)) files.push(action);
  }
  return files;
}

// `a && 0 || b` is always b: 0, false, '' and null are falsy in expressions, so `||` never keeps them. Write the
// condition the other way round (`!a && b || 0`), so the falsy value comes last
test('no expression picks a falsy value with && before ||', async () => {
  const found = [];
  for (const file of await yamlFiles()) {
    (await readFile(file, 'utf8')).split('\n').forEach((line, index) => {
      if (/&&\s*(0|false|''|""|null)\s*\|\|/.test(line))
        found.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
    });
  }

  expect(found).toEqual([]);
});

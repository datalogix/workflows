import { expect, test } from 'vitest';
import { addDatabaseCheck, inspectHealth } from '../stacks/laravel/health.js';
import { APP_SERVICE_PROVIDER, folder, tempRoot } from './helpers.js';

test('adds the database check to an empty boot()', () => {
  const updated = addDatabaseCheck(APP_SERVICE_PROVIDER);
  expect(updated).toMatch(/public function boot\(\): void\n {4}\{\n {8}\/\/ \/up fails/);
  expect(updated).toMatch(/DB::connection\(\)->getPdo\(\);\n {8}\}\);\n {4}\}\n\}/);
  expect(updated).toMatch(
    /use Illuminate\\Foundation\\Events\\DiagnosingHealth;\nuse Illuminate\\Support\\Facades\\DB;\nuse Illuminate\\Support\\Facades\\Event;\nuse Illuminate\\Support\\ServiceProvider;/,
  );
  expect(addDatabaseCheck(updated)).toBe(updated);
  // CRLF line ends, from a Windows checkout, are kept
  const crlf = addDatabaseCheck(APP_SERVICE_PROVIDER.replace(/\n/g, '\r\n'));
  expect(crlf).toBe(updated.replace(/\n/g, '\r\n'));
});

test('keeps the existing code of boot()', () => {
  const updated = addDatabaseCheck(
    APP_SERVICE_PROVIDER.replace('    {\n        //\n    }\n}', '    {\n        Model::shouldBeStrict();\n    }\n}'),
  );
  expect(updated).toMatch(/\}\);\n\n {8}Model::shouldBeStrict\(\);/);
});

test('adds the imports after the namespace when the provider has none', () => {
  const bare = APP_SERVICE_PROVIDER.replace('use Illuminate\\Support\\ServiceProvider;\n\n', '')
    .replace(' extends ServiceProvider', '')
    .replace('boot(): void', 'boot()');
  expect(addDatabaseCheck(bare)).toMatch(
    /namespace App\\Providers;\n\nuse Illuminate\\Foundation\\Events\\DiagnosingHealth;\nuse Illuminate\\Support\\Facades\\DB;\nuse Illuminate\\Support\\Facades\\Event;\n\nclass AppServiceProvider\n/,
  );
});

test('leaves unusual files to the developer', () => {
  expect(addDatabaseCheck('<?php\nclass Foo {}\n')).toBe(null);
});

test('inspects the project files', async (t) => {
  const root = await tempRoot(t, 'health-');
  expect(await inspectHealth(root)).toStrictEqual({ laravel: false, route: null, databaseCheck: false });

  const app = await folder(t, {
    'bootstrap/app.php': "->withRouting(web: 'x', health: '/up')",
    'app/Providers/AppServiceProvider.php': addDatabaseCheck(APP_SERVICE_PROVIDER),
  });
  expect(await inspectHealth(app)).toStrictEqual({ laravel: true, route: '/up', databaseCheck: true });
});

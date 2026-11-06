# Minimum coverage

The tests of every stack fail when the test suite covers less than `min-coverage` percent of the code, 100 by default. The coverage counts statements, methods and conditionals together (the `elements` of a Clover report), so every branch of an `if` must run in a test, not only every line.

## How it is checked

After the test suite passes, the [`coverage`](../.github/actions/coverage/action.yml) action reads the Clover report the tests wrote, from the first of `clover.xml`, `build/logs/clover.xml`, `build/clover.xml` and `coverage/clover.xml` written after the tests started (an older one, committed or left by an earlier step, is ignored). It fails:

- when the coverage is below the minimum, listing the files not fully covered (at most 50) with their covered and total elements;
- when no tests ran, or they wrote no report: configure the report as below;
- when the report measures no code: check which files the coverage includes.

Where it runs:

| Workflow | Where | Driver |
| --- | --- | --- |
| [`laravel-app-tests`](laravel/app-tests.md) | The PHP test suite (`composer test`, `php artisan test` or `test-command`). The `package.json` `test` script is not checked | `pcov`, installed when `min-coverage` is not 0 |
| [`laravel-package-tests`](laravel/package-tests.md) | The newest combination of the matrix, the one that uploads to Codecov | `coverage-driver` (`pcov` by default) |
| [`node-app-tests`](js/app-tests.md) | The `test` script (or `test-command`) | the project's (`@vitest/coverage-v8`, Jest's own) |
| [`node-package-tests`](js/package-tests.md) | Each Node version, on the first runner of `os` (every runner measures the same code) | the project's |

`test-command: none` and `tests: false` turn the check off with the suite. `min-coverage: 0` turns off only the check.

## Writing the report

PHPUnit and Pest, in `phpunit.xml`:

```xml
<coverage>
    <report>
        <clover outputFile="clover.xml"/>
    </report>
</coverage>
<source>
    <include>
        <directory>app</directory>
    </include>
</source>
```

`source` decides what counts: list the folders of your code (`app` in an app, `src` in a package). Locally, without `pcov` or Xdebug, PHPUnit only warns that it cannot collect coverage; a `phpunit.xml` with `failOnWarning="true"` then fails: run `vendor/bin/pest --no-coverage`, or install `pcov`.

Vitest, with `@vitest/coverage-v8` in `devDependencies`, in `vitest.config.ts`:

```ts
export default defineConfig({
    test: {
        coverage: {
            enabled: true,
            reporter: ['text', 'clover'],
            include: ['src/**'],
        },
    },
});
```

Jest: `coverageReporters: ['text', 'clover']` and `collectCoverage: true` in `jest.config.js`, with `collectCoverageFrom` for what counts.

## Lowering or turning it off

In the project's workflow file:

```yaml
    with:
      min-coverage: 90   # 0 turns the check off
```

`check` warns when the tests check a minimum but no `phpunit.xml`, `vitest.config.*`, `vite.config.*`, `jest.config.*` or `package.json` mentions a Clover report. Setup does not ask for the minimum: write `min-coverage` by hand; setup keeps it.

Code the tests should not count (generated code, a bootstrap file) belongs out of the coverage's `source` or `include`, or behind `@codeCoverageIgnore` (PHPUnit) or `/* v8 ignore next */` (Vitest), not in a lower minimum.

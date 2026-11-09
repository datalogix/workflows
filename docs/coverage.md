# Minimum coverage

The tests read the coverage of the test suite from the Clover report it writes, show it in the job summary and fail below `min-coverage` percent of the code: 100 by default in packages (`package.yml`), 0 by default in apps (`project.yml`), so an app sees its coverage without failing until it sets a minimum. The coverage counts statements, methods and conditionals together (the `elements` of a Clover report), so every branch of an `if` must run in a test, not only every line.

## How it is checked

After the test suite passes, the [`coverage`](../.github/actions/coverage/action.yml) action reads the Clover report the tests wrote, from the first of `clover.xml`, `build/logs/clover.xml`, `build/clover.xml` and `coverage/clover.xml` written after the tests started (an older one, committed or left by an earlier step, is ignored). The job summary shows the percentage and the files not fully covered (at most 50) with their covered and total elements. With a minimum, it fails:

- when the coverage is below the minimum, listing those files in the log too;
- when no tests ran, or they wrote no report: configure the report as below;
- when the report measures no code: check which files the coverage includes.

Without a minimum (`min-coverage: 0`), the last two only add a notice to the run.

Where it runs:

| Workflow | Where | Driver |
| --- | --- | --- |
| [`laravel-app-tests`](laravel/app-tests.md) | The PHP test suite (`composer test`, `php artisan test` or `test-command`). The `package.json` `test` script is not read | `pcov`, installed with the suite |
| [`laravel-package-tests`](laravel/package-tests.md) | The newest combination of the matrix, the one that uploads to Codecov, when `min-coverage` is not 0 | `coverage-driver` (`pcov` by default) |
| [`node-app-tests`](js/app-tests.md) | The `test` script (or `test-command`) | the project's (`@vitest/coverage-v8`, Jest's own) |
| [`node-package-tests`](js/package-tests.md) | Each Node version, on the first runner of `os` (every runner measures the same code), when `min-coverage` is not 0 | the project's |

`test-command: none` and `tests: false` turn the coverage off with the suite. In packages, `min-coverage: 0` turns off only the check.

## Writing the report

Every project ignores the report in `.gitignore`, next to PHPUnit's cache:

```gitignore
/.phpunit.cache
clover.xml
```

### Laravel packages

`phpunit.xml.dist`, the same in every package:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"
         bootstrap="vendor/autoload.php"
         cacheDirectory=".phpunit.cache"
         colors="true"
         failOnRisky="true"
         failOnWarning="true"
>
    <testsuites>
        <testsuite name="Laravel Package Test Suite">
            <directory suffix="Test.php">tests</directory>
        </testsuite>
    </testsuites>
    <coverage>
        <report>
            <clover outputFile="clover.xml"/>
            <text outputFile="php://stdout"/>
        </report>
    </coverage>
    <source>
        <include>
            <directory suffix=".php">src</directory>
        </include>
    </source>
</phpunit>
```

The `text` report prints the coverage of each file after the tests. `failOnRisky` and `failOnWarning` fail the suite on a test without assertions and on a PHPUnit warning (invalid configuration, deprecated feature), which otherwise pass silently.

### Laravel apps

The `phpunit.xml` of the Laravel skeleton already has `<source>` with `app`. Add `cacheDirectory`, `failOnRisky` and `failOnWarning` to `<phpunit>` (as in packages) and the reports before `<source>`:

```xml
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:noNamespaceSchemaLocation="vendor/phpunit/phpunit/phpunit.xsd"
         bootstrap="vendor/autoload.php"
         cacheDirectory=".phpunit.cache"
         colors="true"
         failOnRisky="true"
         failOnWarning="true"
>
    <!-- testsuites of the skeleton -->
    <coverage>
        <report>
            <clover outputFile="clover.xml"/>
            <text outputFile="php://stdout" showOnlySummary="true"/>
        </report>
    </coverage>
    <source>
        <include>
            <directory>app</directory>
        </include>
    </source>
    <!-- php of the skeleton -->
</phpunit>
```

`showOnlySummary` keeps the log of a large app short: the job summary lists the files not fully covered.

`source` decides what counts: list the folders of your code (`app` in an app, `src` in a package). Locally, without `pcov` or Xdebug, PHPUnit only warns that it cannot collect coverage, and `failOnWarning` turns that into a failure: run `vendor/bin/pest --no-coverage`, or install `pcov`.

### JavaScript

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

## Setting the minimum

In the workflow file, to lower or turn off the minimum of a package, or to require one in an app:

```yaml
    with:
      min-coverage: 90   # 0: no minimum (packages then skip the coverage)
```

`check` warns when no `phpunit.xml`, `vitest.config.*`, `vite.config.*`, `jest.config.*` or `package.json` mentions a Clover report, in an app (which then shows no coverage) or in a package that checks a minimum. Setup does not ask for the minimum: write `min-coverage` by hand; setup keeps it.

Code the tests should not count (generated code, a bootstrap file) belongs out of the coverage's `source` or `include`, or behind `@codeCoverageIgnore` (PHPUnit) or `/* v8 ignore next */` (Vitest), not in a lower minimum.

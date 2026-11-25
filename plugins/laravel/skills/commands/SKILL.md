---
name: commands
description: The Laravel details of the ci plugin's plan, fix-ci, fix-security and incident commands. Load it only when one of those commands asks for it.
---

# Laravel details of the ci plugin's commands

## plan

- Where to explore: models, controllers, routes, views.
- Extra risks: none beyond the command's.

## fix-ci

- Checks of the tests job to fix: Pint, PHPStan, Rector, the PHP tests, the typecheck (`typecheck`, `types:check` or `type-check`), lint (`lint` or `check`) and `test` scripts of `package.json`, ESLint, Prettier and Stylelint run without a script (in a package, the `js` job), the check that lint changed no files, `composer audit` and the Node audit.
- Validate: the specific test, Pint, PHPStan, Rector, the `package.json` script, or ESLint, Prettier or Stylelint on the failing files, `composer audit` or the Node audit.

## fix-security

- Checks: the pre-PR verification of the laravel:conventions skill (Pint, PHPStan, Rector and the related tests).

## incident

- Reported: an exception or a performance problem (slow route, job, command or scheduled task).
- Exception callers: controllers, jobs, Livewire components, listeners.
- Performance: open the route's action, or the job, command or scheduled task. Look for queries in loops (N+1), missing eager loading, missing indexes for the queries' `where` and `orderBy` columns, unbounded `get()` or `all()`, synchronous HTTP calls or mail, heavy work that belongs in a queue.

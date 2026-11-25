---
name: commands
description: The PHP (Symfony and plain PHP) details of the ci plugin's plan, fix-ci, fix-security and incident commands. Load it only when one of those commands asks for it.
---

# PHP details of the ci plugin's commands

## plan

- Where to explore: controllers, routes, services, entities and repositories (Symfony), templates, configuration.
- Extra risks: none beyond the command's.

## fix-ci

- Checks of the tests job to fix: Pint, PHPStan, Rector, the lint command (PHP-CS-Fixer, ECS, Psalm), the PHP tests, the typecheck (`typecheck`, `types:check` or `type-check`), lint (`lint` or `check`) and `test` scripts of `package.json`, ESLint, Prettier and Stylelint run without a script (in a package, the `js` job), the check that lint changed no files, `composer audit` and the Node audit.
- Validate: the specific test, the formatter or PHPStan on the changed files, Rector, the lint command, the `package.json` script, or ESLint, Prettier or Stylelint on the failing files, `composer audit` or the Node audit.

## fix-security

- Checks: the pre-PR verification of the php:conventions skill (the formatter and PHPStan on the changed files, Rector, the lint command and the related tests).

## incident

- Reported: an exception and, from services that report them, possibly a performance problem (a slow route, handler or command).
- Exception callers: controllers, Messenger handlers, console commands, event subscribers, or the entry script of a plain PHP app.
- Performance: open the controller or script, or the handler or command. Look for queries in loops (N+1, often Doctrine's lazy loading of associations), missing joins or fetch modes, missing indexes for the queries' `where` and `orderBy` columns, unbounded `findAll()` or queries without a limit, synchronous HTTP calls or mail, heavy work that belongs in a queue (Messenger).

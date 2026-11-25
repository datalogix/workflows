---
name: commands
description: The JavaScript details of the ci plugin's plan, fix-ci, fix-security and incident commands. Load it only when one of those commands asks for it.
---

# JavaScript details of the ci plugin's commands

## plan

- Where to explore: pages and routes, components, server routes or API handlers, middleware, data access.
- Extra risks: what runs on the server and what on the client.

## fix-ci

- Checks of the tests job to fix: the typecheck (`typecheck`, `types:check` or `type-check`), lint (`lint` or `check`), `test`, `test:e2e` and `build` scripts of `package.json`, ESLint, Prettier and Stylelint run without a script, the check that lint changed no files, and the audit.
- Usually flaky: end-to-end tests that fail on timing or network. Say so instead of patching around them.
- Validate: the specific test or spec, the typecheck, the linter on the changed files, the build or the audit.

## fix-security

- Checks: the pre-PR verification of the js:conventions skill (the typecheck, the linter on the changed files and the related tests).

## incident

- Reported: an exception and, from services that report them, possibly a performance problem (a slow page, API route or server function).
- Exception callers: pages, components, server routes, API handlers, middleware, server actions. A file from a build output (`.next/`, `.output/`, a minified bundle) points to its source through the route or component name: find it in the source tree. Tell whether it happens on the server (rendering, server routes, server actions) or in the browser: the fix and the impact differ.
- Performance: open the page, route or function. Look for queries in loops, missing indexes, unbounded queries, sequential `await`s that could run in parallel, data fetched on every request that could be cached, heavy work on the request path.

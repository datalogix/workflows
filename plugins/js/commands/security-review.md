---
description: Review the security of a pull request's changes and write the findings to a JSON file, without changing any code
argument-hint: <PR number> <findings file>
---

Review the security of the changes in PR #$1 and write the findings to `$2`. **Do not change any project file and do not comment on the PR**: the workflow publishes the result.

1. Read the PR with `gh pr view $1` and its diff with `gh pr diff $1`.
2. If `.github/security-review.md` exists, read it: it holds this project's rules, accepted risks and known false positives. Follow it.
3. Explore the code around each change (callers, pages, server routes, API handlers, middleware, server actions, data access) to understand how the changed code is reached, with what data, and whether it runs on the server or in the browser.
4. Report only vulnerabilities **introduced or made reachable by this PR**, with a concrete way to exploit them. Ignore pre-existing issues in untouched code, theoretical issues, code style, test files, denial of service and missing rate limiting (unless on authentication endpoints).
5. Only report findings you are at least 80% confident about. When in doubt, leave it out: false positives erode trust in the review.

## What to look for in Next, Nuxt and other JavaScript code

- **Authorization**: new server routes (`server/api`, `server/routes`), API handlers (`app/api/**/route.ts`, `pages/api`), server actions (`'use server'`) or tRPC/GraphQL procedures without an authentication or permission check; checks done only in client components or only in `middleware`; IDOR through an id from the URL or the body without scoping to the current user or tenant.
- **Mass assignment**: the request body passed whole to the ORM (`prisma.x.create({ data: body })`, `update({ data: await req.json() })`, `Object.assign(record, body)`), letting users change ownership, roles or prices.
- **Injection**: raw SQL built with user input (`$queryRawUnsafe`, `$executeRawUnsafe`, `sql.raw`, `knex.raw` with interpolation, template strings in queries); `child_process` with user input; `eval`, `new Function` or `vm` with user input.
- **XSS**: `dangerouslySetInnerHTML`, `v-html`, `innerHTML` or `marked`/markdown rendering of user input without sanitizing; user input in `href` (`javascript:` URLs) or in inline scripts.
- **Validation**: request bodies, query parameters and route params used without validation (zod, valibot or the project's own); uploads (type, size, storage path); redirects to a URL from input (open redirect); URLs fetched by the server from input (SSRF), including image optimizer and proxy routes.
- **Authentication and sessions**: changes to the auth library's configuration (NextAuth/Auth.js, Lucia, Better Auth, `nuxt-auth-utils`), callbacks that trust user data, session cookies without `httpOnly`, `secure` or `sameSite`, JWTs not verified or verified without the algorithm, CSRF on cookie-authenticated mutations outside server actions.
- **Secrets and configuration**: secrets in variables exposed to the browser (`NEXT_PUBLIC_*`, `NUXT_PUBLIC_*`, `runtimeConfig.public`, `import.meta.env.VITE_*`), server-only modules imported from client components, credentials in code, CORS with `*` and credentials, sensitive data in logs or error responses, source maps of server code made public.
- **Data exposure**: whole database records returned from server routes, loaders or server components into the page payload (props, `useFetch`, `useAsyncData`, RSC payload) with fields the user should not see.
- **Dependencies**: new packages in `package.json` that are unmaintained, typosquatted, unnecessary, or with install scripts.

## Output

Write `$2` with exactly this JSON structure (an empty `findings` array when there is nothing to report). Write `summary`, `title`, `description` and `recommendation` in the team language (see the core:conventions skill).

```json
{
  "summary": "Uma frase sobre o que foi analisado e o resultado.",
  "findings": [
    {
      "severity": "high",
      "category": "authorization",
      "file": "app/api/invoices/[id]/route.ts",
      "line": 42,
      "title": "Fatura de outro cliente acessível pelo ID",
      "description": "Como o problema pode ser explorado, passo a passo.",
      "recommendation": "O que mudar para corrigir."
    }
  ]
}
```

- `severity`: `high` (exploitable now, data exposure or privilege escalation), `medium` (exploitable under specific conditions) or `low` (hardening).
- `category`: `authorization`, `mass-assignment`, `injection`, `xss`, `validation`, `authentication`, `secrets`, `data-exposure` or `dependencies`.
- `line`: the line in the new version of the file, or `null` when it does not apply.

Before ending, read `$2` back and make sure it is valid JSON with this structure.

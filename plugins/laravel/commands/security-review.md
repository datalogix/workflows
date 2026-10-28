---
description: Review the security of a pull request's changes and write the findings to a JSON file, without changing any code
argument-hint: <PR number> <findings file>
---

Review the security of the changes in PR #$1 and write the findings to `$2`. **Do not change any project file and do not comment on the PR**: the workflow publishes the result.

1. Read the PR with `gh pr view $1` and its diff with `gh pr diff $1`.
2. If `.github/security-review.md` exists, read it: it holds this project's rules, accepted risks and known false positives. Follow it.
3. Explore the code around each change (callers, routes, policies, middleware, models) to understand how the changed code is reached and with what data.
4. Report only vulnerabilities **introduced or made reachable by this PR**, with a concrete way to exploit them. Ignore pre-existing issues in untouched code, theoretical issues, code style, test files, denial of service and missing rate limiting (unless on authentication endpoints).
5. Only report findings you are at least 80% confident about. When in doubt, leave it out: false positives erode trust in the review.

## What to look for in Laravel code

- **Authorization**: new routes, controller actions, Livewire actions or API endpoints without `authorize`, policies, gates or middleware; `can` checks on the wrong model; IDOR through route model binding without scoping to the current user or tenant.
- **Mass assignment**: `$guarded = []`, `forceFill`, `fill($request->all())`, `create($request->all())` or `update($request->all())`; new `$fillable` fields that let users change ownership, roles or prices.
- **Injection**: `DB::raw`, `whereRaw`, `orderByRaw`, `selectRaw`, `havingRaw` or raw `DB::statement` with user input; column names from input in `orderBy`/`where`; `exec`, `shell_exec`, `Process` with user input.
- **XSS**: `{!! !!}`, `@php echo`, `Js::from` misuse, `HtmlString` or `new HtmlString` with user input; unescaped data in Alpine or Livewire attributes.
- **Validation**: user input used without validation, especially files (`mimes`, size, storage path), redirects (open redirect) and URLs fetched by the server (SSRF).
- **Authentication and sessions**: changes to guards, password reset, email verification, remember tokens, `Auth::login` / `loginUsingId` with user-controlled IDs, CSRF exceptions (`validateCsrfTokens(except:)`), signed URLs without `signed` middleware.
- **Secrets and configuration**: credentials or tokens in code, `APP_DEBUG` or debug routes enabled, CORS with `*` and credentials, sensitive data in logs, responses or exceptions.
- **Data exposure**: models returned directly from controllers or API resources exposing hidden attributes, missing `$hidden`, pagination or exports without scoping.
- **Dependencies**: new packages in `composer.json` or `package.json` that are unmaintained, typosquatted or unnecessary.

## Output

Write `$2` with exactly this JSON structure (an empty `findings` array when there is nothing to report). Write `summary`, `title`, `description` and `recommendation` in the team language (see the laravel:conventions skill).

```json
{
  "summary": "Uma frase sobre o que foi analisado e o resultado.",
  "findings": [
    {
      "severity": "high",
      "category": "authorization",
      "file": "app/Http/Controllers/InvoiceController.php",
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

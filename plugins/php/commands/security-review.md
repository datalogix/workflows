---
description: Review the security of a pull request's changes and write the findings to a JSON file, without changing any code
argument-hint: <PR number> <findings file>
---

Review the security of the changes in PR #$1 and write the findings to `$2`. **Do not change any project file and do not comment on the PR**: the workflow publishes the result.

1. Read the PR with `gh pr view $1` and its diff with `gh pr diff $1`.
2. If `.github/security-review.md` exists, read it: it holds this project's rules, accepted risks and known false positives. Follow it.
3. Explore the code around each change (callers, routes, firewalls and voters, entities, forms) to understand how the changed code is reached and with what data.
4. Report only vulnerabilities **introduced or made reachable by this PR**, with a concrete way to exploit them. Ignore pre-existing issues in untouched code, theoretical issues, code style, test files, denial of service and missing rate limiting (unless on authentication endpoints).
5. Only report findings you are at least 80% confident about. When in doubt, leave it out: false positives erode trust in the review.

## What to look for in Symfony and PHP code

- **Authorization**: new routes or controller actions outside the firewall or `access_control` of `config/packages/security.yaml`, without `#[IsGranted]`, `denyAccessUnlessGranted` or a voter; voters that grant on the wrong subject; IDOR through `#[MapEntity]` or an id from the request without checking it belongs to the current user or tenant. In plain PHP, pages that skip the session or role check the others do.
- **Mass assignment**: forms or the Serializer deserializing request data straight into entities, letting users set ownership, roles or prices (`allow_extra_fields`, missing `groups`, `setRoles` reachable from a form).
- **Injection**: DQL, `createNativeQuery` or DBAL `executeQuery`/`executeStatement` built by string concatenation with user input; PDO or `mysqli` queries without bound parameters; column names from input in `orderBy`; `exec`, `shell_exec`, `system`, `passthru` or `Process` with user input; `include`/`require` of a user-controlled path; `unserialize` of user data.
- **XSS**: Twig's `|raw` or autoescape turned off with user data; in plain PHP, `echo` or `<?=` of user data without `htmlspecialchars`.
- **Validation**: user input used without validation (constraints, `filter_var`), especially files (type, size, storage path), redirects (open redirect) and URLs fetched by the server (SSRF).
- **Authentication and sessions**: changes to authenticators, password hashing or reset, remember-me, login with user-controlled ids, CSRF protection turned off in forms (`csrf_protection: false`) or not checked on state-changing actions, `session_regenerate_id` missing after login in plain PHP.
- **Secrets and configuration**: credentials or tokens in code or in the committed `.env`/`.env.prod` (they belong in `.env.local` or Symfony secrets), `APP_DEBUG` or the web profiler enabled in production, CORS with `*` and credentials (`nelmio_cors`), sensitive data in logs, responses or exceptions.
- **Data exposure**: entities serialized whole in API responses, exposing passwords or internal fields; pagination or exports without scoping.
- **Dependencies**: new packages in `composer.json` or `package.json` that are unmaintained, typosquatted or unnecessary.

## Output

Write `$2` with exactly this JSON structure (an empty `findings` array when there is nothing to report). Write `summary`, `title`, `description` and `recommendation` in the team language (see the core:conventions skill).

```json
{
  "summary": "Uma frase sobre o que foi analisado e o resultado.",
  "findings": [
    {
      "severity": "high",
      "category": "authorization",
      "file": "src/Controller/InvoiceController.php",
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

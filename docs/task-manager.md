# Task manager

Client requests live in a task manager: any system that follows this page. Only tasks that change code become GitHub issues: the manager creates them, or picks up issues labeled `task`, keeps the link to the task and follows them through the events of its GitHub App. Nothing in this repository depends on the manager apart from the `task` label the setup command creates; this page is the contract the manager follows.

## What becomes an issue

- Tasks that are only explanations or questions stay in the manager.
- Tasks that change code get an issue through the **Create issue** action, chosen by a person for each task, not by its type: a question often turns into a change, and the other way around.
- Issues opened on GitHub become tasks when they get the `task` label (see [Issues opened on GitHub](#issues-opened-on-github)).
- [Production errors](production-errors.md) are linked to a task with **Link existing issue** and the issue's URL; they never become tasks on their own.
- A task has at most one issue. The manager stores its repository and number, and every event is matched by them; issues not linked to a task are ignored unless they have the `task` label.

## The GitHub App

The manager uses one GitHub App for both directions: it creates issues with the App's identity, and GitHub sends the App's webhook to the manager on every issue event. The App is created once and installed on the organization and on any client organization that holds a project's repository; its settings are in [Organization setup](organization-setup.md#5-create-the-task-managers-github-app).

The webhook URL is the same for every repository; the manager tells them apart by the `repository` field of each event. It checks every delivery against `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, with the webhook secret) and rejects the ones that do not match.

Each repository is mapped to a client and project in the manager, so the task list shows which client an issue belongs to.

## Issue body

The manager writes the same sections as the **Tarefa para o Claude** form, so Claude reads the task in the format it already knows, and ends with the link to the task:

```markdown
### O que precisa ser feito

...

### Critérios de aceite

- [ ] ...

### Contexto

...

---

Tarefa: https://<manager>/tasks/123
```

The issue is created without labels, not even `task`, since it is already linked.

## Issues opened on GitHub

A person adds the `task` label to an issue, when opening it or later, to send it to the manager. On an `opened` or `labeled` event whose issue has the label, the manager:

1. Ignores the event when the repository and number are already linked to a task, such as issues created by **Create issue**.
2. Ignores issues with the `incident` label: production errors are linked by hand.
3. Finds the client and project from the repository, and ignores repositories that are not mapped.
4. Creates a task with the issue's title, author and URL, and links it to the issue.

Removing the label does not delete the task or its link: the task follows the issue until it is closed, as in [Status](#status).

## Starting Claude

The manager never adds `claude` or `claude-plan`. A person reads the issue on GitHub and adds `claude-plan` for a plan or `claude` to implement it, as in [Daily use](daily-use.md#a-new-feature-step-by-step):

- A client's request is often ambiguous and should be reviewed before it changes code.
- The `claude` job does not accept runs started by bots, so a label added by the App would be ignored.

## Status

| Issue event                               | Task             |
| ----------------------------------------- | ---------------- |
| `closed` with `state_reason: completed`   | Done             |
| `closed` with `state_reason: not_planned` | Cancelled        |
| `reopened`                                | Back in progress |

Claude's pull requests reference their issue with `Closes #<number>` ([conventions](claude.md#conventions)), so merging one closes the issue and the task. A linked production error closes when it is resolved or ignored in Nightwatch, and reopens when it happens again.

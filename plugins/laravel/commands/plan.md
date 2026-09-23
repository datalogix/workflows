---
description: Analyze an issue and post an implementation plan on it, without changing any code
argument-hint: <issue number>
---

Analyze issue #$ARGUMENTS and post an implementation plan on it. **Do not change any file.**

1. Read the issue and its comments with `gh issue view $ARGUMENTS --comments`.
2. Explore the code to understand where the change fits: models, controllers, routes, views, tests and the patterns already in use.
3. Post the plan with `gh issue comment $ARGUMENTS --body-file -`, written in Portuguese, with these sections:
   - **Entendimento**: what the issue asks for, in a few lines.
   - **Arquivos afetados**: files to create or change, one line about each.
   - **Abordagem**: step-by-step implementation, reusing what already exists.
   - **Riscos**: side effects, migrations, compatibility.
   - **Dúvidas**: ambiguous points that need a decision before implementing (say so if there are none).
   - **Tamanho**: P, M or G.

4. End the comment with: "Para implementar, ajuste o plano se precisar e adicione o label `claude`."

Be concise: the plan should be readable at a glance.

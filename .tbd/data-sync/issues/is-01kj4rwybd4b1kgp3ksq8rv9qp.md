---
type: is
id: is-01kj4rwybd4b1kgp3ksq8rv9qp
title: "Phase 5: Colored help output and CLI polish"
kind: feature
status: closed
priority: 2
version: 4
spec_path: docs/project/specs/active/plan-2026-02-22-polish-and-docs.md
labels:
  - polish
dependencies:
  - type: blocks
    target: is-01kj4rxngnmgzcahnmr8rd57r6
parent_id: is-01kj4rvgkx2mx9n5xmx41yf17j
created_at: 2026-02-23T08:12:21.739Z
updated_at: 2026-02-24T17:31:28.598Z
closed_at: 2026-02-24T17:31:28.590Z
close_reason: "Phase 5 implemented: picocolors, configureHelp styling, showHelpAfterError"
---
Add picocolors dep. Replace custom formatHelp with Commander v14 configureHelp (styleTitle, styleCommandText, styleOptionText). Add showHelpAfterError(). Replace hardcoded epilog with addHelpText('after') promoting blobsy readme/docs. Investigate commandsGroup(). Update help golden tests, add help-error.tryscript.md. Update CHANGELOG.

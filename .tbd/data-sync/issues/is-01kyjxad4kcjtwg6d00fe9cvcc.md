---
type: is
id: is-01kyjxad4kcjtwg6d00fe9cvcc
title: "Epic: Round 7 alpha readiness — implement review findings (v2)"
kind: epic
status: open
priority: 0
version: 34
spec_path: docs/project/design/current/blobsy-design-review-round7-alpha-readiness.md
labels: []
dependencies: []
child_order_hints:
  - is-01kyjxbfgffqse0tb0scsxkjpm
  - is-01kyjxbfvjj7be4455g3appn00
  - is-01kyjxbg6qzjsn8nmsk6v84rr0
  - is-01kyjxbgjc5jdypy5afemzjen9
  - is-01kyjxbgxh0nv52x2ca5v00edq
  - is-01kyjxbh8dcnb3q9bgw0szws06
  - is-01kyjxbhk70c9my602mnrn9nxw
  - is-01kyjxbhyh36zk8mbt7vnchcn9
  - is-01kyjxbja700zv0fmrhvyepkhb
  - is-01kyjxcb8vaana3n3k0fw3s1tb
  - is-01kyjxcbm2fd2ggwy3ktnp54p0
  - is-01kyjxcbymk08gr4e848jsw45z
  - is-01kyjxccd0jfekkep33cq37qfe
  - is-01kyjxccrd5jjzdkhpj7x4qdc1
  - is-01kyjxcd320rmd4vxsydxyqymw
  - is-01kyjxcddv1dbmbbhz7mseeky0
  - is-01kyjxcdvvphj5f8vve6vt3nw5
  - is-01kyjxce88hgw8qs8180kp4vd3
  - is-01kyjxcejq8mjzz9r25rgf3x50
  - is-01kyjxcexdb0rstf4927nzrqmh
  - is-01kyjxcf8dxmbghczttffcj6m5
  - is-01kyjxcfkx2aa2s7hymhx66j2g
  - is-01kyjxda1gt7kvqktxfpa1k3gv
  - is-01kyjxdac6cmrc7m6638rr31ms
  - is-01kyjxdapjj60ee4z93fa560w6
  - is-01kyjxdb16ej1hr1jbf52c0xyf
  - is-01kyjxdbc2n8z7qnqjrx9esck2
  - is-01kyjxdbpygmw6tvcjy8qyyexf
  - is-01kyjxdc1cw9hz6k6qnkd1b1mz
  - is-01kyjxdcd0ze3g4dxraa2v7mbs
  - is-01kyjxdcqy8dckf6k4758m5d8a
  - is-01kyjxdd4rgkt9cppqet4j39yh
  - is-01kyjxddf9t0q76zsm21sx9d8a
created_at: 2026-07-27T23:07:21.106Z
updated_at: 2026-07-27T23:08:59.753Z
---
Implement the alpha-exit matrix (22 gate items) and trailing findings from the round 7 review v2 (62 findings: 6 Blocker / 20 High / 21 Medium / 15 Low). Execution order per the matrix: CI trust (DX-01, TEST-01) -> data safety (TEST-04, DS-01..04, HK-01, BE-03, CLI-01, CLI-02) -> trust boundaries (SEC-02, HK-03, SEC-03) -> transfer viability (BE-01, BE-04, BE-02) -> docs gate (DOCS-01, DOCS-02) -> non-gate cleanup and docs. Each gate item has an acceptance test defined in the review doc's Alpha-Exit Matrix.

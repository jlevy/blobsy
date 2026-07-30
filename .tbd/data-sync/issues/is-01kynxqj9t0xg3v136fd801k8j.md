---
type: is
id: is-01kynxqj9t0xg3v136fd801k8j
title: Close the two-phase remote_key gap in the pre-push hook flow
kind: feature
status: open
priority: 2
version: 1
labels:
  - design
  - hooks
dependencies: []
created_at: 2026-07-29T03:12:15.670Z
updated_at: 2026-07-29T03:12:15.670Z
---
With hooks installed, the documented flow is git commit && git push. The pre-push hook uploads blobs and writes remote_key into working-tree .bref files, but the outgoing commits are already fixed (a pre-push hook cannot amend them), so the pushed .bref lands upstream without remote_key. Teammates cannot blobsy pull that file until the pusher commits the .bref update in a follow-up commit. Found by Bugbot round 10 (PR #4, commit 1baa704).

Mitigations shipped in the design-review PR: the hook prints follow-up-commit guidance after uploads; pull/sync/transfer messages no longer claim 'never pushed' when remote_key is merely uncommitted; README + implementation notes document the two-phase flow.

Structural fix needs a design decision — candidate directions:
1. Derivable keys: make the default key_template deterministic (drop {iso_date_secs}, e.g. {content_sha256_short}/{repo_path}{compress_suffix}); pull falls back to the derived key when remote_key is absent, verifying by content hash after download. Cost: loses date-grouped remote layout; compression fields are also absent from an un-updated .bref, so derivation must try compress-suffix variants or store compression at track time.
2. Assign remote_key at track time: the committed .bref carries its final key from the start; presence of remote_key no longer doubles as the 'pushed' bit, so status/check-unpushed/doctor need a different pushed-signal (e.g. remote existence check or a pushed marker in the stat cache).
3. Hook stages .bref updates: pre-push (or a post-push wrapper) runs git add on updated .bref files so the next commit picks them up automatically. Least invasive but still leaves the one-commit lag and surprises users who curate their index.

Decision owner: jlevy.

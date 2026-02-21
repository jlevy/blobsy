# blobsy Design Review Round 6 (gpt53codexextrahigh)

Date: 2026-02-20 Target: `docs/project/design/current/blobsy-design-v2.md` Context doc
consulted: `docs/project/research/current/research-2026-02-19-sync-tools-landscape.md`

## Findings (ordered by severity)

1. **High - `sync`/`push` commit semantics are internally inconsistent.**

The design says commands can operate on uncommitted refs and mutate refs, but also says
refs must be committed and `sync` only operates on committed refs.

Evidence:

```text
blobsy-design-v2.md:1106-1121
Reads from working tree `.yref` files (can operate on uncommitted refs with warnings).
Algorithm includes updating `.yref` hashes and `remote_key`.
Sync can modify `.yref` files; user must commit them.
```

```text
blobsy-design-v2.md:1149-1150
Same precondition (refs must be committed).
```

```text
blobsy-design-v2.md:1712-1714
`blobsy sync` only operates on files whose `.yref` is committed to git.
It never modifies `.yref` files (except to set `remote_key` after push).
```

Impact: this creates implementation and test ambiguity on core command behavior.

* * *

2. **High - pointer/data publish flow is acknowledged as fragile but not closed by
   design constraints.**

The document identifies a common failure mode ("pushed data but forgot to commit ref")
and says it is invisible locally, but does not enforce a safer default.

Evidence:

```text
blobsy-design-v2.md:2046-2056
Pushed data but forgot to commit the ref...
Problem is invisible to the pusher... this is the most common mistake.
```

The research document states the relevant safety condition: pointer should be written
last after data success.

```text
research-2026-02-19-sync-tools-landscape.md:750-752
Manifest/pointer is written last, after all data files succeed.
```

Impact: teams will repeatedly hit “data exists remotely but git does not reference it”
and the inverse.

* * *

3. **High - `command` backend execution model is under-specified and likely unsafe for
   path interpolation edge cases.**

The design allows arbitrary shell commands with variable interpolation but does not
define quoting/escaping or shell-vs-argv execution semantics.

Evidence:

```text
blobsy-design-v2.md:1504-1523
`command`: arbitrary shell commands for push/pull.
Runs once per file with variable expansion.
```

```text
blobsy-design-v2.md:1529-1533
Example: scp {local} myhost:/data/{remote}
```

Impact: spaces/metacharacters in paths can cause incorrect behavior or
command-injection-like hazards depending on invocation method.

* * *

4. **Medium-High - branch key sanitization is marked “eliminated” while branch-based
   templates remain first-class.**

The design still supports templates using `{git_branch}`, but review-resolution table
says branch sanitization concerns are eliminated because branch names never appear in
keys.

Evidence:

```text
blobsy-design-v2.md:326-327
key_template: "{git_branch}/sha256/{content_sha256}"
```

```text
blobsy-design-v2.md:2457
Branch name sanitization: Eliminated. Branch names never appear in remote keys.
```

Impact: contradiction around detached HEAD and branch-name normalization rules.

* * *

5. **Medium - unresolved contradictions in remote key model, CAS claims, V1 scope, and
   compression suffix contract.**

The default key template is timestamp + short hash + path, which intentionally allows
cross-time duplicates and is not pure CAS. Elsewhere the document labels this default as
content-addressable and states V1 includes content-addressable GC while GC is also
deferred to V2.

Evidence:

```text
blobsy-design-v2.md:246-275
Default key template includes timestamp and path.
Same content next day = new key.
Cross-time duplication is expected.
```

```text
blobsy-design-v2.md:1441
Default shown as "content-addressable".
```

```text
blobsy-design-v2.md:2261-2267
V1 includes content-addressable storage and content-addressable garbage collection.
```

```text
blobsy-design-v2.md:2324-2327
`blobsy gc` is deferred to V2.
```

Compression key derivation is also presented in two potentially conflicting ways:

```text
blobsy-design-v2.md:530-540
Suffix should be in template to avoid collisions.
Alternatively suffix handled automatically from `.yref` compression state.
```

Impact: implementers cannot derive a single canonical key contract.

* * *

6. **Medium - performance envelope claims are optimistic for many-file workloads versus
   research findings.**

The design leans on per-file process spawning and says this is fine for typical
workloads, while also discussing very large file counts.
Research points to substantial gains from batch-oriented engines (`s5cmd`, transfer
batches) for many-file scenarios.

Evidence:

```text
blobsy-design-v2.md:1125-1137
One CLI invocation per file, up to parallel=8.
Simple and works for tens to hundreds of files.
```

```text
blobsy-design-v2.md:2146
10,000 files = 10,000 `.yref` files.
```

```text
research-2026-02-19-sync-tools-landscape.md:436-443
s5cmd optimized for many-file workloads with batch mode.
```

Impact: likely throughput and process-overhead bottlenecks for large fan-out
pushes/pulls.

## Open questions to resolve before implementation

- Is V1 commit-first or working-tree-first for `sync`/`push`?
- Is V1 default truly CAS, or intentionally timestamp+path hybrid?
- Is `blobsy gc` in V1 or V2?
- How are `command` templates executed exactly (shell string vs argv)?
- If `{git_branch}` remains, what is the canonical branch-to-key normalization rule?

## Secondary summary

The architecture direction is strong (per-file refs, git-native conflict handling,
delegated transport), but the current design has several contract-level contradictions
that should be resolved before implementation.
The most important fixes are command semantics (`sync`/`push`), key derivation contract,
and safe command backend execution semantics.

# Using blobsy in GitHub Actions

A copy-paste workflow that checks out a repo, pulls blobsy-tracked files, and runs a job
that needs them.
Read-only credentials are sufficient for pulling (the S3 health check is
a HeadBucket probe, not a write).

```yaml
name: build

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # for OIDC-based AWS credentials
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Credentials for your backend. For s3:// backends, OIDC role assumption
      # is the recommended approach (no long-lived secrets):
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/blobsy-ci-read
          aws-region: us-east-1

      - name: Install blobsy
        run: npm install -g blobsy

      - name: Pull tracked files
        env:
          BLOBSY_NO_HOOKS: "1" # kill switch: skips hook install AND disables any installed blobsy hooks
        run: |
          blobsy health
          blobsy pull
          blobsy verify

      - name: Build / test
        run: |
          # your steps here — tracked files are now present on disk
          ls -lh data/
```

Notes:

- `blobsy pull` is idempotent and verifies hashes on download; a failed step can simply
  be re-run.
- For jobs that must **upload** (e.g. publishing build artifacts through blobsy), use
  credentials with write access and run `blobsy push` — but prefer keeping CI read-only
  unless you specifically need this.
- Command backends are refused by default in fresh environments; if your repo uses one,
  set `BLOBSY_TRUST_COMMAND_BACKEND=1` in the step’s `env` **only after reviewing the
  commands** in `.blobsy.yml` (they run with the job’s credentials).
- Cache note: blobs are content-addressed, so `actions/cache` keyed on the `.bref`
  files’ hashes can skip repeat downloads for unchanged data if pull time matters.

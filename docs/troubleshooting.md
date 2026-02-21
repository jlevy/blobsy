# Troubleshooting

Common issues and solutions for blobsy.

## Authentication Errors

### S3: “Access Denied” or “InvalidAccessKeyId”

Your AWS credentials are not configured or have insufficient permissions.

```
blobsy health
# Error: S3 error (HeadBucket): Access Denied
```

**Solutions:**

- Ensure `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set, or that your AWS CLI
  profile is configured (`aws configure`).
- Verify the IAM user/role has `s3:PutObject`, `s3:GetObject`, `s3:HeadObject`, and
  `s3:DeleteObject` permissions on the target bucket and prefix.
- For S3-compatible services (MinIO, R2), also set the `endpoint` in `.blobsy.yml`.

### S3: “NoSuchBucket”

The bucket in your backend URL doesn’t exist.

```
blobsy health
# Error: S3 error (HeadBucket): The specified bucket does not exist
```

**Solutions:**

- Verify the bucket name: `blobsy config backends.default.url`
- Create the bucket in the AWS console or via `aws s3 mb s3://your-bucket`.
- Check the region: the bucket may exist but in a different region than configured.

## Permission Errors

### “EACCES: permission denied” on local backend

The local backend directory isn’t writable.

**Solutions:**

- Check directory permissions: `ls -la /path/to/local/store`
- Fix permissions: `chmod u+w /path/to/local/store`
- Verify the path in your config: `blobsy config backends.default.url`

### “Command backend not allowed”

Blobsy blocks command backends from `.blobsy.yml` by default to prevent arbitrary code
execution.

```
Error: .blobsy.yml specifies a 'command' backend, which can execute arbitrary shell
commands. This is not allowed from repo config by default.
```

**Solutions:**

- Trust this repo: `blobsy trust`
- Or configure the backend in your user-level config (`~/.blobsy.yml`) instead.
- To revoke trust later: `blobsy trust --revoke`
- For CI/testing, set `BLOBSY_TRUST_ALL=1` (not recommended for interactive use).

## Network Errors

### “ENOTFOUND” or “ETIMEDOUT”

Cannot reach the storage service.

**Solutions:**

- Check your internet connection.
- For custom endpoints, verify the URL: `blobsy config backends.default.endpoint`
- Test connectivity: `curl -I <endpoint-url>`
- Behind a proxy? Set `HTTPS_PROXY` environment variable.

### “SlowDown” or rate limiting

Too many requests to the storage service.

**Solutions:**

- Reduce parallelism by pushing/pulling fewer files at once.
- Wait and retry -- blobsy will succeed on subsequent runs since already-pushed blobs
  are skipped.

## Common Mistakes

### “Not inside a git repository”

Blobsy requires a git repository to function.

**Solutions:**

- `cd` into your git repo before running blobsy commands.
- Initialize a repo: `git init`

### “No .blobsy.yml found”

Blobsy hasn’t been initialized in this repo.

**Solutions:**

- Run `blobsy init <url>` to create the config.
- If the config is at a non-standard location, check that you’re in the repo root.

### Tracking a file that’s already tracked

This is safe and idempotent.
If the file hasn’t changed, blobsy reports “already tracked (unchanged)”. If it has
changed, blobsy updates the `.yref` hash.

### Accidentally tracking a `.yref` file

Blobsy automatically strips the `.yref` extension from paths, so
`blobsy track data/model.bin.yref` is equivalent to `blobsy track data/model.bin`.

## Hook Manager Issues

### “Hook manager detected”

Blobsy detects lefthook, husky, or similar hook managers and avoids overwriting their
hooks.

**Solutions:**

- Add blobsy to your hook manager config.
  For lefthook:

```yaml
# lefthook.yml
pre-commit:
  commands:
    blobsy:
      run: blobsy hook pre-commit
```

- For husky, add to `.husky/pre-commit`:

```bash
blobsy hook pre-commit
```

### “Existing pre-commit hook found”

A non-blobsy hook exists at `.git/hooks/pre-commit`.

**Solutions:**

- Add `blobsy hook pre-commit` to your existing hook script.
- Or remove the existing hook and let blobsy install its own:
  `rm .git/hooks/pre-commit && blobsy hooks install`

## Stat Cache

### Files re-hashed on every status check

The stat cache may be corrupted or missing.

**Solutions:**

- Run `blobsy doctor --fix` to rebuild the cache.
- Manually clear: `rm -rf .blobsy/stat-cache/` and re-run `blobsy track` on affected
  files.

### Stale cache after external file changes

If files are modified outside of blobsy (e.g., by a build tool), the stat cache may be
stale.

**Solutions:**

- Re-track changed files: `blobsy track <file>`
- Or clear the cache for a fresh start: `rm -rf .blobsy/stat-cache/`

## Getting More Information

- Use `--verbose` for detailed output on any command.
- Use `--json` for machine-readable output (useful for debugging scripts).
- Run `blobsy doctor` to check for common issues.
- Run `blobsy doctor --fix` to attempt automatic repairs.

# blobsy

Store large files anywhere.
Track them in git.

A simpler, more flexible, serverless alternative to Git LFS and other large file storage
solutions for Git. Blobsy is a standalone CLI that tracks large files with lightweight
`.yref` pointer files committed to Git, while the actual data lives in any storage
backend — S3, GCS, R2, Azure, or a local directory.
No special server. No hosting requirements.
Just `blobsy track`, `blobsy push`, `blobsy pull`.

## Development

See [docs/development.md](docs/development.md) for full setup and workflow details.

```bash
pnpm install
pnpm build
pnpm test
```

## Publishing

See [docs/publishing.md](docs/publishing.md).

## License

MIT

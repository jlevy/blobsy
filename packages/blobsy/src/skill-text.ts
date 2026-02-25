/**
 * Embedded documentation text for `blobsy skill` command.
 *
 * Provides self-documentation for AI agents to discover blobsy capabilities
 * without needing to read external files. Context-efficient (~200-300 tokens).
 */

export const SKILL_TEXT = `\
# blobsy

Git-native large file storage. Track large files with \`.bref\` pointers in Git,
store blobs in S3/local/custom backends.

## Installation

\`\`\`bash
npm install -g blobsy@latest
blobsy setup --auto s3://bucket/prefix/
\`\`\`

## When to Use

- Large binary files (models, datasets, media, archives)
- Share files across machines without committing to Git
- Content-addressable, deduplicated storage
- Keywords: blobsy, .bref, large files, Git LFS alternative

## Quick Reference

\`\`\`bash
blobsy track <path...>     # Track files (creates .bref)
blobsy push [path...]      # Upload to backend
blobsy pull [path...]      # Download from backend
blobsy status --json       # Current state (JSON)
blobsy doctor --json       # Health check (JSON)
\`\`\`

## Current State

For dynamic info, use:
- \`blobsy status --json\` - Tracked files, sync state
- \`blobsy doctor --json\` - Configuration, health, issues

All commands: \`--json\`, \`--quiet\`, \`--verbose\`, \`--dry-run\`
`;

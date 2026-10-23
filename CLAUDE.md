# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24 (see `.nvmrc`)
- [pnpm](https://pnpm.io/) (enabled via `corepack enable`)
- [uv](https://docs.astral.sh/uv/) (recommended — required for Copier template
  generation and flowmark markdown formatting)

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm build` | Build all packages |
| `pnpm dev` | Build in watch mode |
| `pnpm test` | Run tests |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:coverage` | Run tests with coverage |
| `pnpm lint` | Lint and auto-fix |
| `pnpm lint:check` | Lint without fixing (CI) |
| `pnpm format` | Format all files (Prettier + flowmark) |
| `pnpm format:md` | Format markdown only (flowmark) |
| `pnpm format:check` | Check code formatting (Prettier only, for CI) |
| `pnpm typecheck` | Type check all packages |
| `pnpm publint` | Validate package.json for publishing |
| `pnpm ci` | Run full CI pipeline locally |

## Dependency Management

| Command | Description |
| --- | --- |
| `pnpm upgrade:check` | Check for available updates |
| `pnpm upgrade` | Safe upgrade (minor + patch) |
| `pnpm upgrade:major` | Interactive major version upgrades |

## Project Structure

```
.
├── docs/                    # Project documentation
│   ├── development.md       # This file
│   └── publishing.md        # Publishing and release guide
├── packages/
│   └── <package>/           # Your package(s)
│       ├── src/             # Source code
│       ├── tests/           # Tests
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsdown.config.ts # Build config
│       └── vitest.config.ts # Test config
├── .github/workflows/       # CI/CD workflows
├── eslint.config.js         # ESLint flat config
├── .prettierrc              # Prettier config (code files)
├── .flowmarkignore          # Flowmark ignore patterns (markdown)
├── lefthook.yml             # Git hooks
├── package.json             # Root workspace config
├── pnpm-workspace.yaml      # Workspace packages
├── tsconfig.json            # Root TypeScript config (project references)
└── tsconfig.base.json       # Shared TypeScript settings
```

## Adding Packages

1. Create a new directory under `packages/`:

   ```bash
   mkdir -p packages/new-package/src packages/new-package/tests
   ```

2. Copy and adapt configuration files from the existing package (`package.json`,
   `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`).

3. Add the package reference to root `tsconfig.json`:

   ```json
   {
     "references": [{ "path": "./packages/existing-package" }, { "path": "./packages/new-package" }]
   }
   ```

## Configuration

### TypeScript

- **Target**: ES2024 (modern JavaScript features for Node 24+)
- **Module resolution**: `Bundler` (optimized for tsdown)
- **Strict settings**: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `exactOptionalPropertyTypes`

### ESLint

- Flat config (`eslint.config.js`) with type-aware rules via `typescript-eslint`
- Promise safety: no floating promises, no misused promises, await-thenable
- Consistent type imports (`import type`)
- Curly braces required for all control statements
- Relaxed rules for test files

### Formatting (Prettier + flowmark)

Code and markdown use separate formatters:

- **Prettier** handles code files (JS/TS, JSON, YAML) — configured in `.prettierrc`
- **[flowmark](https://github.com/jlevy/flowmark)** handles markdown (`.md` files) —
  does semantic line-breaking for cleaner diffs

Prettier is enforced in CI (`pnpm format:check` fails the build on code formatting
issues). Flowmark is best-effort: it runs in pre-commit hooks and via `pnpm format`, but
is not enforced in CI since markdown formatting rarely causes functional issues and
flowmark can be brittle on edge cases.

To disable flowmark locally, comment out the `format-md` command in `lefthook.yml`.

flowmark runs via `uvx` (no npm dependency — requires [uv](https://docs.astral.sh/uv/)
installed).

### Git Hooks (Lefthook)

- **Pre-commit** (parallel):
  - Format staged code files with Prettier
  - Format staged markdown with flowmark (via uvx)
  - Lint staged files with ESLint (with cache and auto-fix)
  - Type check with `pnpm typecheck`
- **Pre-push**:
  - Run full test suite with `pnpm test`

### Build (tsdown)

- ESM-only output (`.mjs` + `.d.mts`)
- Target: Node 24
- Source maps enabled
- TypeScript declarations generated

### Testing (Vitest)

- Coverage via `@vitest/coverage-v8`
- Reporters: text, json, json-summary

# Contributing to Repo Files Sync Action

Thank you for your interest in contributing! Issues and PRs are very welcome.

## 💻 Development

The actual source code of this library is in the `src` folder.

### Prerequisites

- Node.js 24+
- [pnpm](https://pnpm.io/) (recommended version: 10+)

### Scripts

```bash
# Install dependencies
pnpm install

# Run ESLint
pnpm lint

# Run TypeScript type checking
pnpm typecheck

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Run tests in watch mode
pnpm test:watch

# Build the Action
pnpm build

# Format code
pnpm format

# Run the Action locally (requires dist to be built)
pnpm start
```

## Credits

This Action was inspired by:

- [repo-file-sync-action](https://github.com/BetaHuhn/repo-file-sync-action)
- [action-github-workflow-sync](https://github.com/varunsridharan/action-github-workflow-sync)
- [files-sync-action](https://github.com/adrianjost/files-sync-action)
